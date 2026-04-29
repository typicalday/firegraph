/**
 * Firestore implementation of `StorageBackend`.
 *
 * Wraps the existing `FirestoreAdapter`, `TransactionAdapter`, and
 * `BatchAdapter` so the Firestore code path keeps the exact behavior it
 * had before the backend abstraction landed.
 */

import type { Firestore, Query, Transaction } from '@google-cloud/firestore';
import { FieldValue } from '@google-cloud/firestore';

import {
  bulkRemoveEdges as bulkRemoveEdgesImpl,
  removeNodeCascade as removeNodeCascadeImpl,
} from '../bulk.js';
import { FiregraphError } from '../errors.js';
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
  QueryMode,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';
import type {
  BackendCapabilities,
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from './backend.js';
import { createCapabilities } from './backend.js';
import type { BatchAdapter, FirestoreAdapter, TransactionAdapter } from './firestore-adapter.js';
import {
  createBatchAdapter,
  createFirestoreAdapter,
  createTransactionAdapter,
} from './firestore-adapter.js';
import type { PipelineQueryAdapter } from './pipeline-adapter.js';
import { createPipelineQueryAdapter } from './pipeline-adapter.js';
import type { DataPathOp } from './write-plan.js';
import { assertSafePath, assertUpdatePayloadExclusive } from './write-plan.js';

export interface FirestoreBackendOptions {
  queryMode?: QueryMode;
  scopePath?: string;
}

/** Build a `data.a.b.c` dotted path for Firestore's `update()` API. */
function dottedDataPath(op: DataPathOp): string {
  assertSafePath(op.path);
  return `data.${op.path.join('.')}`;
}

/**
 * Build the patch payload Firestore expects from an `UpdatePayload`.
 *
 * - `replaceData` sets the whole `data` field at once (full replacement).
 *   Tagged Firestore types from the migration sandbox are reconstructed
 *   here. Cannot be combined with `dataOps`.
 * - `dataOps` becomes one Firestore field-update entry per terminal op,
 *   keyed by `data.<dotted.path>`. Delete ops use `FieldValue.delete()`.
 *   Sibling keys at every depth are preserved by Firestore's update
 *   semantics for nested maps.
 * - `updatedAt` is always stamped with `FieldValue.serverTimestamp()`.
 * - `v` is stamped at the root when provided.
 */
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

/**
 * Stamp `createdAt`/`updatedAt` server-timestamp sentinels on a
 * timestampless record. Used for `setDoc`.
 */
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

class FirestoreTransactionBackend implements TransactionBackend {
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

class FirestoreBatchBackend implements BatchBackend {
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

/**
 * Capabilities the unified Firestore backend currently implements. This is
 * intentionally conservative: only the operations actually exposed by
 * firegraph today appear here. Phase 2 splits this into edition-specific
 * capability sets (`firestore-standard` vs `firestore-enterprise`).
 */
const FIRESTORE_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'core.read',
  'core.write',
  'core.transactions',
  'core.batch',
  'core.subgraph',
  'raw.firestore',
]);

class FirestoreBackendImpl implements StorageBackend {
  readonly capabilities: BackendCapabilities = createCapabilities(FIRESTORE_CAPS);
  readonly collectionPath: string;
  readonly scopePath: string;
  private readonly adapter: FirestoreAdapter;
  private readonly pipelineAdapter?: PipelineQueryAdapter;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    private readonly queryMode: QueryMode,
    scopePath: string,
  ) {
    this.collectionPath = collectionPath;
    this.scopePath = scopePath;
    this.adapter = createFirestoreAdapter(db, collectionPath);
    if (queryMode === 'pipeline') {
      this.pipelineAdapter = createPipelineQueryAdapter(db, collectionPath);
    }
  }

  // --- Reads ---

  getDoc(docId: string): Promise<StoredGraphRecord | null> {
    return this.adapter.getDoc(docId);
  }

  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    if (this.pipelineAdapter) {
      return this.pipelineAdapter.query(filters, options);
    }
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
      return fn(new FirestoreTransactionBackend(txAdapter, this.db));
    });
  }

  createBatch(): BatchBackend {
    const batchAdapter = createBatchAdapter(this.db, this.collectionPath);
    return new FirestoreBatchBackend(batchAdapter, this.db);
  }

  // --- Subgraphs ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    const subPath = `${this.collectionPath}/${parentNodeUid}/${name}`;
    const newScope = this.scopePath ? `${this.scopePath}/${name}` : name;
    return new FirestoreBackendImpl(this.db, subPath, this.queryMode, newScope);
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
 * Create a Firestore-backed `StorageBackend`.
 *
 * The query-mode auto-fallback for the emulator (`FIRESTORE_EMULATOR_HOST`)
 * is performed at the call site (`createGraphClient`) so that the backend
 * itself doesn't reach into `process.env`.
 */
export function createFirestoreBackend(
  db: Firestore,
  collectionPath: string,
  options: FirestoreBackendOptions = {},
): StorageBackend {
  const queryMode = options.queryMode ?? 'pipeline';
  const scopePath = options.scopePath ?? '';
  return new FirestoreBackendImpl(db, collectionPath, queryMode, scopePath);
}
