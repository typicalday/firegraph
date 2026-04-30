/**
 * Firestore Enterprise edition `StorageBackend`.
 *
 * The Enterprise edition wires the classic Query API (transactions, single-
 * doc reads/writes, listeners) alongside the Pipelines query engine. Pipeline
 * mode is the default for `query()` outside the emulator; classic mode is
 * always used for transactions and doc-level operations because pipelines
 * have no transactional binding (per Firestore's GA notes — April 2026).
 *
 * Capability declarations target the full Enterprise surface that the
 * shipped `@google-cloud/firestore@8.5.0` SDK exposes typed APIs for:
 * core read/write/transactions/batch/subgraph, `query.aggregate`,
 * `query.select`, `query.join` (via Pipelines `equalAny(field, values)`
 * for single-statement multi-source fan-out), `query.dml` (gated by
 * the opt-in `previewDml` flag — Pipeline `delete()` / `update(...)`
 * stages are `@beta` in 8.5.0; see the per-capability rationale below),
 * `search.vector` (via the classic `findNearest` API for parity with
 * Standard), `search.fullText` (via Pipelines
 * `search({ query: documentMatches(...) })`), `search.geo` (via
 * Pipelines `search({ query: geoDistance(...).lessThanOrEqual(...) })`),
 * and `raw.firestore`. Capabilities that remain fundamentally absent on
 * 8.5.0 — `realtime.listen` — stay undeclared until the SDK exposes an
 * addressable feature. See the comment block above
 * `FirestoreEnterpriseCapability` for the per-capability rationale.
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
import {
  runFirestorePipelineDelete,
  runFirestorePipelineUpdate,
} from '../internal/firestore-bulk-dml.js';
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
import { runFirestoreClassicExpand } from '../internal/firestore-classic-expand.js';
import { runFirestorePipelineExpand } from '../internal/firestore-expand.js';
import { runFirestoreFullTextSearch } from '../internal/firestore-fulltext.js';
import { runFirestoreGeoSearch } from '../internal/firestore-geo.js';
import { runFirestoreFindEdgesProjected } from '../internal/firestore-projection.js';
import { runFirestoreEngineTraversal } from '../internal/firestore-traverse.js';
import { runFirestoreFindNearest } from '../internal/firestore-vector.js';
import type { DataPathOp } from '../internal/write-plan.js';
import { assertSafePath, assertUpdatePayloadExclusive } from '../internal/write-plan.js';
import { buildEdgeQueryPlan } from '../query.js';
import { deserializeFirestoreTypes } from '../serialization.js';
import type {
  AggregateSpec,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  CascadeResult,
  EngineTraversalParams,
  EngineTraversalResult,
  ExpandParams,
  ExpandResult,
  FindEdgesParams,
  FindNearestParams,
  FullTextSearchParams,
  GeoSearchParams,
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
 * bound; the GA notes call this out explicitly). `search.vector` (Phase 8)
 * is implemented via the classic `Query.findNearest(...)` API for parity
 * with the Standard edition — see `findNearest()` below.
 *
 * `search.fullText` and `search.geo` (Phase 12) are implemented via the
 * Pipelines `search(...)` stage exposed in `@google-cloud/firestore@8.5.0`.
 * The 8.5.0 typed surface adds `documentMatches(...)`, `score()`, and
 * `geoDistance(...)` as first-class expressions (all `@beta` and gated to
 * the `Search` stage); the `Pipeline.search(options)` method itself is
 * also first-class. Standard does NOT declare these caps — full-text
 * search and geospatial queries are Enterprise-only product features
 * regardless of SDK shape, so the routing invariant (declared cap ⇒
 * method exists ⇒ index exists) demands that the cap stay edition-gated.
 *
 * Conservative declaration matters here: declaring a capability we don't
 * implement turns the type-level gate (Phase 3) into a lie that throws at
 * runtime instead of failing to compile. The inverse also matters:
 * implementing without declaring leaves the surface accessible only via
 * `as any` casts, which silently bypasses the capability gate.
 *
 * **`query.join` (Phase 13a) is implemented via Pipelines `equalAny`.**
 * Multi-source fan-out collapses to a single round trip:
 * `db.pipeline().collection(path).where(equalAny(sourceField, sources))
 * .execute()`. The shared helper lives at `src/internal/firestore-expand.ts`.
 * The classic Query API caps `'in'` at 30 elements per call, forcing
 * `ceil(N/30)` round trips; pipeline `equalAny(field, values)` accepts
 * an arbitrary list, so a 1k-source fan-out goes from ~34 round trips
 * to one. When `queryMode === 'classic'` (emulator or explicit override),
 * the classic chunked path in `firestore-classic-expand.ts` is used
 * instead — same observable contract, different round-trip profile.
 *
 * **`query.dml` (Phase 13b) is wired through `runFirestorePipelineDelete`
 * and `runFirestorePipelineUpdate` (`src/internal/firestore-bulk-dml.ts`)
 * but is gated by an opt-in `FirestoreEnterpriseOptions.previewDml`
 * flag.** The underlying `Pipeline.delete()` and
 * `Pipeline.update(transformedFields)` stages are `@beta` in
 * `@google-cloud/firestore@8.5.0` (`firestore.d.ts:12647` /
 * `firestore.d.ts:12662`). When `previewDml: true`, the cap is declared
 * and `bulkDelete` / `bulkUpdate` dispatch to single-statement Pipelines
 * stages — same observable contract as SQLite/DO, one round trip per
 * call, no fetch-then-write loop. A one-time `console.warn` fires on
 * backend construction so the `@beta` status is visible. When
 * `previewDml: false` (default), the cap is NOT declared; `bulk.ts`
 * cascade and `client.bulkDelete()` / `client.bulkUpdate()` route
 * through the existing `bulkRemoveEdges` fetch-then-write fallback.
 * SQLite and Cloudflare DO declare `query.dml` unconditionally because
 * their `DELETE … WHERE …` / `UPDATE … SET …` paths are GA, not preview.
 */
export type FirestoreEnterpriseCapability =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  | 'traversal.serverSide'
  | 'search.vector'
  | 'search.fullText'
  | 'search.geo'
  | 'raw.firestore';

/**
 * Base capability set declared by every Firestore Enterprise backend.
 * `query.dml` is conditionally added on construction when
 * `FirestoreEnterpriseOptions.previewDml === true`; see the
 * `query.dml` rationale comment above and the constructor below.
 */
const ENTERPRISE_BASE_CAPS: ReadonlySet<FirestoreEnterpriseCapability> =
  new Set<FirestoreEnterpriseCapability>([
    'core.read',
    'core.write',
    'core.transactions',
    'core.batch',
    'core.subgraph',
    'query.aggregate',
    'query.select',
    'query.join',
    'traversal.serverSide',
    'search.vector',
    'search.fullText',
    'search.geo',
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
  /**
   * Opt in to Pipelines DML stages (`@beta` in `@google-cloud/firestore@8.5.0`:
   * `Pipeline.delete()` at `firestore.d.ts:12647`,
   * `Pipeline.update(transformedFields)` at `firestore.d.ts:12662`).
   *
   * When `false` (default), this backend does NOT declare `query.dml` and
   * `client.bulkDelete()` / `client.bulkUpdate()` throw
   * `UNSUPPORTED_OPERATION` (or, via `bulk.ts`'s cascade path, fall back
   * to the read-then-write loop in `bulkRemoveEdges`).
   *
   * When `true`, the backend declares `query.dml` and dispatches both
   * methods to single-statement Pipeline stages via
   * `runFirestorePipelineDelete` / `runFirestorePipelineUpdate`. A
   * one-time `console.warn` fires on the first backend created with the
   * flag so the `@beta` status is visible without disrupting tests or
   * production traffic. The flag intentionally has no effect on
   * `defaultQueryMode: 'classic'` — the classic-API path has no DML stage
   * to fall back to, so opting into preview DML in classic mode is a
   * misconfiguration; we accept the flag silently rather than throw to
   * keep the option surface ergonomic across the dual-mode toggle. The
   * routing layer relies on `query.dml` being a structural cap, not a
   * runtime promise — so the cap is still declared even in classic mode,
   * and the methods still dispatch through Pipelines (Pipeline DML works
   * regardless of the read-path `queryMode`).
   */
  previewDml?: boolean;
  /** Internal: the logical scope path inherited from a parent subgraph. */
  scopePath?: string;
}

let _emulatorFallbackWarned = false;
let _classicInProductionWarned = false;
let _previewDmlWarned = false;

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
  readonly capabilities: BackendCapabilities<FirestoreEnterpriseCapability>;
  readonly collectionPath: string;
  readonly scopePath: string;
  private readonly adapter: FirestoreAdapter;
  private readonly pipelineAdapter?: PipelineQueryAdapter;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    private readonly queryMode: FirestoreEnterpriseQueryMode,
    scopePath: string,
    private readonly previewDml: boolean,
  ) {
    this.collectionPath = collectionPath;
    this.scopePath = scopePath;
    this.adapter = createFirestoreAdapter(db, collectionPath);
    if (queryMode === 'pipeline') {
      this.pipelineAdapter = createPipelineQueryAdapter(db, collectionPath);
    }
    // `query.dml` is opt-in because the Pipeline `delete()` / `update(...)`
    // stages are `@beta` in 8.5.0; declaring it without the flag would
    // promise behaviour we'd then have to revert if the SDK shape shifts.
    const caps = previewDml
      ? new Set<FirestoreEnterpriseCapability>([...ENTERPRISE_BASE_CAPS, 'query.dml'])
      : ENTERPRISE_BASE_CAPS;
    this.capabilities = createCapabilities(caps);
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
    // Inherit `previewDml` so subgraphs declare the same cap as the parent
    // — otherwise `client.subgraph(uid).bulkDelete(...)` would silently
    // route through the read-then-write fallback while the parent client
    // dispatched through Pipelines, breaking parity.
    return new FirestoreEnterpriseBackendImpl(
      this.db,
      subPath,
      this.queryMode,
      newScope,
      this.previewDml,
    );
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

  // --- Native vector / nearest-neighbour search (capability: search.vector) ---

  /**
   * Run a vector / nearest-neighbour query via the shared classic-API
   * helper. Enterprise and Standard delegate to one implementation so the
   * field-path normalisation, validation surface, and result shape stay
   * consistent across editions.
   *
   * Why classic and not the pipeline `findNearest` stage: the deliverable
   * (top-K by similarity) is achieved by either path; the classic API
   * works identically on both editions today and sidesteps the
   * pipeline-vs-emulator forking the rest of this backend has to manage.
   * When pipeline `findNearest` becomes preferable for composing with
   * other pipeline stages, swap the implementation behind
   * `runFirestoreFindNearest`; callers and the capability declaration
   * stay put.
   *
   * Index requirements are identical to Standard — single-field vector
   * index on the indexed `vectorField`, plus a composite index whenever
   * additional `where` filters narrow the candidate set.
   */
  findNearest(params: FindNearestParams): Promise<StoredGraphRecord[]> {
    return runFirestoreFindNearest(this.db.collection(this.collectionPath), params);
  }

  // --- Native full-text search (capability: search.fullText) ---

  /**
   * Run a full-text search via Firestore Pipelines `search(...)` stage.
   * Translates `documentMatches(query)` against the indexed search
   * fields, sorts by relevance score (`score().descending()`), and
   * applies identifying filters as a follow-up `where(...)` stage
   * because `search` must be the first stage of a pipeline.
   *
   * Enterprise-only: full-text search is an Enterprise product feature.
   * Standard does not declare `search.fullText` regardless of SDK
   * surface, and the SQLite-shaped backends have no native FTS index.
   *
   * Index requirements: an FTS index on the indexed search fields
   * (configured in Firestore's index config). Without the index the
   * underlying `search` stage returns no rows; the firegraph layer
   * cannot detect that case ahead of time.
   */
  fullTextSearch(params: FullTextSearchParams): Promise<StoredGraphRecord[]> {
    return runFirestoreFullTextSearch(this.db, this.collectionPath, params);
  }

  // --- Native geospatial distance search (capability: search.geo) ---

  /**
   * Run a geospatial distance query via Firestore Pipelines
   * `search(...)` stage. The same `geoDistance(geoField, point)`
   * expression feeds the radius cap (`<= radiusMeters`) and the
   * nearest-first sort (when `orderByDistance` is true / unset).
   * Identifying filters apply as a follow-up `where(...)` stage.
   *
   * Enterprise-only: same Enterprise-product-feature gating as FTS.
   *
   * Index requirements: a geospatial index on the indexed `geoField`.
   * Same caveat as FTS — unindexed geo searches return no rows
   * server-side and the firegraph layer cannot pre-detect that.
   */
  geoSearch(params: GeoSearchParams): Promise<StoredGraphRecord[]> {
    return runFirestoreGeoSearch(this.db, this.collectionPath, params);
  }

  // --- Server-side multi-source fan-out (capability: query.join) ---

  /**
   * Fan out from `params.sources` over a single edge type in one server-
   * side round trip when running in pipeline mode, or via a chunked
   * classic-API fan-out when running in classic mode.
   *
   * Pipeline mode (default outside the emulator): one call to
   * `db.pipeline().collection(path).where(equalAny(sourceField, sources))
   * .execute()`. `equalAny` has no documented cap, so a 1k-source fan-
   * out is one round trip.
   *
   * Classic mode (emulator, or `defaultQueryMode: 'classic'`): chunks
   * `params.sources` into 30-element groups (the classic `'in'`
   * operator's documented cap), dispatches one query per chunk in
   * parallel, concats the results, and applies a cross-chunk re-sort +
   * total-limit slice. Same observable contract, `ceil(N/30)` round
   * trips. The chunked path is still a win over the per-source
   * `findEdges` loop in `traverse.ts` — 100 sources go from 100 round
   * trips to 4.
   */
  expand(params: ExpandParams): Promise<ExpandResult> {
    if (this.queryMode === 'pipeline') {
      return runFirestorePipelineExpand(this.db, this.collectionPath, params);
    }
    return runFirestoreClassicExpand(this.adapter, params);
  }

  // --- Server-side DML (capability: query.dml, gated by previewDml) ---

  /**
   * Single-statement bulk DELETE via Pipeline `delete()` stage. Wired only
   * when the backend was created with `previewDml: true`; otherwise the
   * cap isn't declared and `client.bulkDelete()` throws
   * `UNSUPPORTED_OPERATION` (or `bulk.ts` cascade falls back to
   * `bulkRemoveEdges`).
   *
   * Empty filter lists are rejected at the helper boundary —
   * see `runFirestorePipelineDelete`'s `assertNonEmptyFilters`.
   *
   * Subgraph isolation comes from `this.collectionPath`: the pipeline's
   * `collection(path)` source IS the subgraph, so there's no separate
   * `scope` predicate to enforce (unlike SQLite's leading-`scope`-`?`
   * filter).
   */
  bulkDelete(filters: QueryFilter[], options?: BulkOptions): Promise<BulkResult> {
    return runFirestorePipelineDelete(this.db, this.collectionPath, filters, options);
  }

  /**
   * Single-statement bulk UPDATE via Pipeline
   * `update(transformedFields)` stage. Same gating and scoping as
   * `bulkDelete` above. The patch is flattened into one
   * `AliasedExpression` per terminal leaf via the shared `flattenPatch`
   * pipeline; `deleteField()` sentinels are rejected at the helper
   * boundary (the typed `update(AliasedExpression[])` surface in 8.5.0
   * has no field-deletion transform — see `runFirestorePipelineUpdate`).
   */
  bulkUpdate(
    filters: QueryFilter[],
    patch: BulkUpdatePatch,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    return runFirestorePipelineUpdate(this.db, this.collectionPath, filters, patch, options);
  }

  // --- Engine-level multi-hop traversal (capability: traversal.serverSide) ---

  /**
   * Compile a multi-hop traversal spec into one nested Pipeline and
   * dispatch a single round trip via `define` + `addFields(child
   * .toArrayExpression().as(...))`. The compiler in
   * `firestore-traverse-compiler.ts` validates spec eligibility (depth
   * ≤ `MAX_PIPELINE_DEPTH`, every hop has `limitPerSource`, response-
   * size product ≤ `maxReads`) and the executor in
   * `firestore-traverse.ts` builds + decodes the tree.
   *
   * Unlike `bulkDelete` / `bulkUpdate`, this method is GA-typed in 8.5.0
   * (no `@beta` annotation on `define`, `addFields`, `toArrayExpression`,
   * or `variable`), so it does NOT need a `previewDml`-style opt-in.
   *
   * `defaultQueryMode` is irrelevant here — engine traversal always
   * dispatches through Pipelines because the join-key binding (`define`
   * + `variable`) has no classic Query API equivalent. Specs that
   * arrive on a classic-mode backend still execute via Pipelines; the
   * `queryMode` toggle only affects the read query path
   * (`query()` / `expand()`).
   */
  runEngineTraversal(params: EngineTraversalParams): Promise<EngineTraversalResult> {
    return runFirestoreEngineTraversal(this.db, this.collectionPath, params);
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

  const previewDml = options.previewDml ?? false;
  if (previewDml && !_previewDmlWarned) {
    _previewDmlWarned = true;
    console.warn(
      '[firegraph] Firestore Enterprise backend created with `previewDml: true`. ' +
        'bulkDelete()/bulkUpdate() will dispatch through Pipeline.delete() / ' +
        'Pipeline.update(transformedFields), both `@beta` in @google-cloud/firestore@8.5.0. ' +
        'The typed surface may shift before GA — pin your firestore SDK or be ready to ' +
        'set `previewDml: false` and route through the read-then-write fallback if needed.',
    );
  }

  const scopePath = options.scopePath ?? '';
  return new FirestoreEnterpriseBackendImpl(
    db,
    collectionPath,
    effectiveMode,
    scopePath,
    previewDml,
  );
}
