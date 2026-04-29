/**
 * Firestore Standard edition `StorageBackend`.
 *
 * The Standard edition only has the classic Query API — pipelines and
 * Enterprise-only features (full-text search, geo, joins, DML) are not
 * available. This file deliberately does not import the pipeline adapter so
 * a Standard-only deployment never pulls Pipeline code into its bundle.
 *
 * Capability declarations follow the conservative invariant established in
 * Phase 1: only declare what the file actually implements at runtime.
 * Phases 4-10 will add `query.aggregate`, `query.select`, `search.vector`,
 * and `realtime.listen` once the matching backend methods exist.
 */

import type { Firestore, Query, Transaction } from '@google-cloud/firestore';
import { FieldValue } from '@google-cloud/firestore';

import {
  bulkRemoveEdges as bulkRemoveEdgesImpl,
  removeNodeCascade as removeNodeCascadeImpl,
} from '../bulk.js';
import { FiregraphError } from '../errors.js';
import type {
  BackendCapabilities,
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from '../internal/backend.js';
import { createCapabilities } from '../internal/backend.js';
import type {
  BatchAdapter,
  FirestoreAdapter,
  TransactionAdapter,
} from '../internal/firestore-classic-adapter.js';
import {
  createBatchAdapter,
  createFirestoreAdapter,
  createTransactionAdapter,
} from '../internal/firestore-classic-adapter.js';
import type { DataPathOp } from '../internal/write-plan.js';
import { assertSafePath, assertUpdatePayloadExclusive } from '../internal/write-plan.js';
import { buildEdgeQueryPlan } from '../query.js';
import { deserializeFirestoreTypes } from '../serialization.js';
import type {
  BulkOptions,
  BulkResult,
  Capability,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';

/**
 * The Standard backend's static capability set.
 *
 * Conservative declaration: only capabilities backed by an actual runtime
 * method are declared. Phases 4-10 layer in `query.aggregate`,
 * `query.select`, `search.vector`, and `realtime.listen` as their
 * corresponding methods land.
 */
const STANDARD_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'core.read',
  'core.write',
  'core.transactions',
  'core.batch',
  'core.subgraph',
  'raw.firestore',
]);

export interface FirestoreStandardOptions {
  /** Internal: the logical scope path inherited from a parent subgraph. */
  scopePath?: string;
}

/** Build a `data.a.b.c` dotted path for Firestore's `update()` API. */
function dottedDataPath(op: DataPathOp): string {
  assertSafePath(op.path);
  return `data.${op.path.join('.')}`;
}

function buildFirestoreUpdate(update: UpdatePayload, db: Firestore): Record<string, unknown> {
  assertUpdatePayloadExclusive(update);
  const out: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (update.replaceData) {
    out.data = deserializeFirestoreTypes(update.replaceData, db);
  } else if (update.dataOps) {
    for (const op of update.dataOps) {
      const key = dottedDataPath(op);
      out[key] = op.delete ? FieldValue.delete() : op.value;
    }
  }
  if (update.v !== undefined) {
    out.v = update.v;
  }
  return out;
}

function stampWritableRecord(record: WritableRecord): Record<string, unknown> {
  const now = FieldValue.serverTimestamp();
  const out: Record<string, unknown> = {
    aType: record.aType,
    aUid: record.aUid,
    axbType: record.axbType,
    bType: record.bType,
    bUid: record.bUid,
    data: record.data,
    createdAt: now,
    updatedAt: now,
  };
  if (record.v !== undefined) out.v = record.v;
  return out;
}

class FirestoreStandardTransactionBackend implements TransactionBackend {
  constructor(
    private readonly adapter: TransactionAdapter,
    private readonly db: Firestore,
  ) {}

  getDoc(docId: string): Promise<StoredGraphRecord | null> {
    return this.adapter.getDoc(docId);
  }

  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    return this.adapter.query(filters, options);
  }

  async setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    this.adapter.setDoc(
      docId,
      stampWritableRecord(record),
      mode === 'merge' ? { merge: true } : undefined,
    );
  }

  async updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    this.adapter.updateDoc(docId, buildFirestoreUpdate(update, this.db));
  }

  async deleteDoc(docId: string): Promise<void> {
    this.adapter.deleteDoc(docId);
  }
}

class FirestoreStandardBatchBackend implements BatchBackend {
  constructor(
    private readonly adapter: BatchAdapter,
    private readonly db: Firestore,
  ) {}

  setDoc(docId: string, record: WritableRecord, mode: WriteMode): void {
    this.adapter.setDoc(
      docId,
      stampWritableRecord(record),
      mode === 'merge' ? { merge: true } : undefined,
    );
  }

  updateDoc(docId: string, update: UpdatePayload): void {
    this.adapter.updateDoc(docId, buildFirestoreUpdate(update, this.db));
  }

  deleteDoc(docId: string): void {
    this.adapter.deleteDoc(docId);
  }

  commit(): Promise<void> {
    return this.adapter.commit();
  }
}

class FirestoreStandardBackendImpl implements StorageBackend {
  readonly capabilities: BackendCapabilities = createCapabilities(STANDARD_CAPS);
  readonly collectionPath: string;
  readonly scopePath: string;
  private readonly adapter: FirestoreAdapter;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    scopePath: string,
  ) {
    this.collectionPath = collectionPath;
    this.scopePath = scopePath;
    this.adapter = createFirestoreAdapter(db, collectionPath);
  }

  // --- Reads ---

  getDoc(docId: string): Promise<StoredGraphRecord | null> {
    return this.adapter.getDoc(docId);
  }

  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    return this.adapter.query(filters, options);
  }

  // --- Writes ---

  setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    return this.adapter.setDoc(
      docId,
      stampWritableRecord(record),
      mode === 'merge' ? { merge: true } : undefined,
    );
  }

  updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    return this.adapter.updateDoc(docId, buildFirestoreUpdate(update, this.db));
  }

  deleteDoc(docId: string): Promise<void> {
    return this.adapter.deleteDoc(docId);
  }

  // --- Transactions / Batches ---

  runTransaction<T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (firestoreTx: Transaction) => {
      const txAdapter = createTransactionAdapter(this.db, this.collectionPath, firestoreTx);
      return fn(new FirestoreStandardTransactionBackend(txAdapter, this.db));
    });
  }

  createBatch(): BatchBackend {
    const batchAdapter = createBatchAdapter(this.db, this.collectionPath);
    return new FirestoreStandardBatchBackend(batchAdapter, this.db);
  }

  // --- Subgraphs ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    const subPath = `${this.collectionPath}/${parentNodeUid}/${name}`;
    const newScope = this.scopePath ? `${this.scopePath}/${name}` : name;
    return new FirestoreStandardBackendImpl(this.db, subPath, newScope);
  }

  // --- Cascade & bulk ---

  removeNodeCascade(
    uid: string,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<CascadeResult> {
    return removeNodeCascadeImpl(this.db, this.collectionPath, reader, uid, options);
  }

  bulkRemoveEdges(
    params: FindEdgesParams,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    return bulkRemoveEdgesImpl(this.db, this.collectionPath, reader, params, options);
  }

  // --- Cross-collection ---

  async findEdgesGlobal(
    params: FindEdgesParams,
    collectionName?: string,
  ): Promise<StoredGraphRecord[]> {
    const name = collectionName ?? this.collectionPath.split('/').pop()!;
    const plan = buildEdgeQueryPlan(params);

    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'findEdgesGlobal() requires a query, not a direct document lookup. ' +
          'Omit one of aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }

    const collectionGroupRef = this.db.collectionGroup(name);
    let q: Query = collectionGroupRef;
    for (const f of plan.filters) {
      q = q.where(f.field, f.op, f.value);
    }
    if (plan.options?.orderBy) {
      q = q.orderBy(plan.options.orderBy.field, plan.options.orderBy.direction ?? 'asc');
    }
    if (plan.options?.limit !== undefined) {
      q = q.limit(plan.options.limit);
    }
    const snap = await q.get();
    return snap.docs.map((doc) => doc.data() as StoredGraphRecord);
  }
}

/**
 * Create a Firestore Standard-edition `StorageBackend`.
 *
 * Standard Firestore does not support pipelines or any Enterprise-only
 * features. `data.*` filters require composite indexes; callers that mostly
 * filter on built-in fields (`aUid`, `axbType`, `bUid`) avoid that
 * requirement.
 */
export function createFirestoreStandardBackend(
  db: Firestore,
  collectionPath: string,
  options: FirestoreStandardOptions = {},
): StorageBackend {
  const scopePath = options.scopePath ?? '';
  return new FirestoreStandardBackendImpl(db, collectionPath, scopePath);
}
