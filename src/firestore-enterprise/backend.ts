/**
 * Firestore Enterprise edition `StorageBackend`.
 *
 * The Enterprise edition wires the classic Query API (transactions, single-
 * doc reads/writes, listeners) alongside the Pipelines query engine. Pipeline
 * mode is the default for `query()` outside the emulator; classic mode is
 * always used for transactions and doc-level operations because pipelines
 * have no transactional binding (per Firestore's GA notes — April 2026).
 *
 * Capability declarations target the full Enterprise surface — pipelines
 * GA features (aggregate, join, DML, full-text search, geo, vector). The
 * actual implementation of those extension methods lands in Phases 4-10
 * of the capability refactor; today this file declares only the core
 * capabilities that match the runtime methods it exposes.
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
import { runFirestoreAggregate } from '../internal/firestore-aggregate.js';
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
import { runFirestoreFindEdgesProjected } from '../internal/firestore-projection.js';
import type { DataPathOp } from '../internal/write-plan.js';
import { assertSafePath, assertUpdatePayloadExclusive } from '../internal/write-plan.js';
import { buildEdgeQueryPlan } from '../query.js';
import { deserializeFirestoreTypes } from '../serialization.js';
import type {
  AggregateSpec,
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';
import type { PipelineQueryAdapter } from './pipeline-adapter.js';
import { createPipelineQueryAdapter } from './pipeline-adapter.js';

/**
 * Capability union declared by the Firestore Enterprise backend.
 *
 * `core.transactions` is included because transactions are still supported
 * via the classic Query API (pipelines themselves are not transactionally
 * bound; the GA notes call this out explicitly). The pipeline-only
 * extension capabilities (`query.join`, `search.*`) are NOT declared yet —
 * subsequent phases wire them in once the matching backend methods exist,
 * at which point this union grows in lockstep with the cap-set literal
 * below.
 *
 * Conservative declaration matters here: declaring a capability we don't
 * implement turns the type-level gate (Phase 3) into a lie that throws at
 * runtime instead of failing to compile.
 *
 * **`query.dml` is intentionally omitted.** The Firestore SDK shipped at
 * `@google-cloud/firestore@8.3.0` does not expose pipeline DML stages —
 * the `Pipeline` class has read stages (`where`, `select`, `aggregate`,
 * `sort`, etc.) but no `remove` / `update` / `replace` mutations. The only
 * way to delete or update many docs today is the existing
 * `bulkRemoveEdges` fetch-then-write loop (driven by `BulkWriter`), which
 * is a client-side fan-out, not a server-side DML statement. Declaring
 * `query.dml` here without a real server-side path would defeat the point
 * of the capability — its consumers (e.g. `bulk.ts` cascade rewrite)
 * branch on the cap to skip the fetch-then-write loop entirely. SQLite
 * and Cloudflare DO declare `query.dml` because they really do execute a
 * single `DELETE … WHERE …` / `UPDATE … SET …` statement; Firestore
 * doesn't, so it stays on the `bulkRemoveEdges` path.
 *
 * When pipeline DML lands in a future SDK release, the wiring is
 * straightforward: build a `pipeline-dml.ts` stage builder, add the
 * capability here and to `ENTERPRISE_CAPS`, and implement
 * `bulkDelete` / `bulkUpdate` methods that dispatch through the new
 * stages. The `DmlExtension` type and `GraphClient.bulkDelete` /
 * `bulkUpdate` shims are already in place — Phase 5 made them backend-
 * agnostic precisely so this future change is additive.
 */
export type FirestoreEnterpriseCapability =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'raw.firestore';

const ENTERPRISE_CAPS: ReadonlySet<FirestoreEnterpriseCapability> =
  new Set<FirestoreEnterpriseCapability>([
    'core.read',
    'core.write',
    'core.transactions',
    'core.batch',
    'core.subgraph',
    'query.aggregate',
    'query.select',
    'raw.firestore',
  ]);

export type FirestoreEnterpriseQueryMode = 'pipeline' | 'classic';

export interface FirestoreEnterpriseOptions {
  /**
   * Query execution mode for `findEdges` / `findNodes`. `'pipeline'` (the
   * default outside the emulator) routes through the Pipeline query engine;
   * `'classic'` falls back to the Query API. Pipeline-only capabilities
   * (search, aggregate, etc., once implemented) always use pipelines
   * regardless of this option.
   *
   * The emulator does not execute pipeline queries, so this option is
   * forced to `'classic'` whenever `FIRESTORE_EMULATOR_HOST` is set, with
   * a one-time `console.warn` if the caller explicitly asked for pipeline
   * mode.
   */
  defaultQueryMode?: FirestoreEnterpriseQueryMode;
  /** Internal: the logical scope path inherited from a parent subgraph. */
  scopePath?: string;
}

let _emulatorFallbackWarned = false;
let _classicInProductionWarned = false;

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

class FirestoreEnterpriseTransactionBackend implements TransactionBackend {
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

class FirestoreEnterpriseBatchBackend implements BatchBackend {
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

class FirestoreEnterpriseBackendImpl implements StorageBackend<FirestoreEnterpriseCapability> {
  readonly capabilities: BackendCapabilities<FirestoreEnterpriseCapability> =
    createCapabilities(ENTERPRISE_CAPS);
  readonly collectionPath: string;
  readonly scopePath: string;
  private readonly adapter: FirestoreAdapter;
  private readonly pipelineAdapter?: PipelineQueryAdapter;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    private readonly queryMode: FirestoreEnterpriseQueryMode,
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
      return fn(new FirestoreEnterpriseTransactionBackend(txAdapter, this.db));
    });
  }

  createBatch(): BatchBackend {
    const batchAdapter = createBatchAdapter(this.db, this.collectionPath);
    return new FirestoreEnterpriseBatchBackend(batchAdapter, this.db);
  }

  // --- Subgraphs ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    const subPath = `${this.collectionPath}/${parentNodeUid}/${name}`;
    const newScope = this.scopePath ? `${this.scopePath}/${name}` : name;
    return new FirestoreEnterpriseBackendImpl(this.db, subPath, this.queryMode, newScope);
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

  // --- Aggregate ---

  /**
   * Aggregate via the classic `Query.aggregate()` API. Supports count/sum/avg
   * — min/max throws `UNSUPPORTED_AGGREGATE`. The Pipelines `aggregate()`
   * stage could in principle add min/max on Enterprise, but that is deferred
   * to a future phase; both editions currently route through the same
   * classic-API helper so capability semantics stay symmetric.
   */
  aggregate(spec: AggregateSpec, filters: QueryFilter[]): Promise<Record<string, number>> {
    return runFirestoreAggregate(this.db.collection(this.collectionPath), spec, filters, {
      edition: 'enterprise',
    });
  }

  // --- Server-side projection (capability: query.select) ---

  /**
   * Run a projecting query via the shared classic-API helper. Enterprise and
   * Standard delegate to the same implementation so the projection contract
   * stays consistent.
   *
   * Why classic and not the pipeline `select()` stage: the byte-savings
   * deliverable (the only reason `findEdgesProjected` exists) is achieved
   * by either path; the classic API works on both editions today and
   * sidesteps the pipeline-vs-emulator forking the rest of this backend has
   * to manage. When pipeline `select()` becomes preferable for some other
   * reason — e.g. composing with a future pipeline-only stage — swap the
   * implementation behind `runFirestoreFindEdgesProjected`; callers and
   * the capability declaration stay put.
   */
  findEdgesProjected(
    select: ReadonlyArray<string>,
    filters: QueryFilter[],
    options?: QueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    return runFirestoreFindEdgesProjected(
      this.db.collection(this.collectionPath),
      select,
      filters,
      options,
    );
  }
}

/**
 * Create a Firestore Enterprise-edition `StorageBackend`.
 *
 * Pipeline mode is the default. When `FIRESTORE_EMULATOR_HOST` is set the
 * effective mode is forced to `'classic'` because the emulator does not
 * execute pipelines; if the caller explicitly asked for pipeline mode in
 * that environment, a one-time `console.warn` surfaces the override so
 * the deployment mismatch is visible without breaking the test run.
 */
export function createFirestoreEnterpriseBackend(
  db: Firestore,
  collectionPath: string,
  options: FirestoreEnterpriseOptions = {},
): StorageBackend<FirestoreEnterpriseCapability> {
  const requestedMode: FirestoreEnterpriseQueryMode = options.defaultQueryMode ?? 'pipeline';
  const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const effectiveMode: FirestoreEnterpriseQueryMode =
    isEmulator && requestedMode === 'pipeline' ? 'classic' : requestedMode;

  if (
    isEmulator &&
    requestedMode === 'pipeline' &&
    effectiveMode === 'classic' &&
    !_emulatorFallbackWarned
  ) {
    _emulatorFallbackWarned = true;
    console.warn(
      '[firegraph] Firestore Enterprise pipeline mode is unavailable in the emulator; ' +
        'falling back to classic Query API for this run. Set ' +
        "`defaultQueryMode: 'classic'` to silence this warning.",
    );
  }

  if (!isEmulator && requestedMode === 'classic' && !_classicInProductionWarned) {
    _classicInProductionWarned = true;
    console.warn(
      "[firegraph] Firestore Enterprise backend created with `defaultQueryMode: 'classic'`. " +
        'Classic-mode `query()` against Enterprise causes full collection scans for ' +
        '`data.*` filters (high billing). For production reads on Standard Firestore, ' +
        "import from `'firegraph/firestore-standard'` instead.",
    );
  }

  const scopePath = options.scopePath ?? '';
  return new FirestoreEnterpriseBackendImpl(db, collectionPath, effectiveMode, scopePath);
}
