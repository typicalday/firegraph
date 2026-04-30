import { GraphBatchImpl } from './batch.js';
import { computeEdgeDocId, computeNodeDocId } from './docid.js';
import {
  createBootstrapRegistry,
  createRegistryFromGraph,
  generateDeterministicUid,
  META_EDGE_TYPE,
  META_NODE_TYPE,
} from './dynamic-registry.js';
import { DynamicRegistryError, FiregraphError, QuerySafetyError } from './errors.js';
import type { BackendCapabilities, StorageBackend, WritableRecord } from './internal/backend.js';
import { NODE_RELATION } from './internal/constants.js';
import { assertNoDeleteSentinels, flattenPatch } from './internal/write-plan.js';
import type { MigrationResult } from './migration.js';
import { migrateRecord, migrateRecords } from './migration.js';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
import { analyzeQuerySafety } from './query-safety.js';
import { createMergedRegistry } from './registry.js';
import { precompileSource } from './sandbox.js';
import { GraphTransactionImpl } from './transaction.js';
import type {
  AggregateResult,
  AggregateSpec,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  Capability,
  CascadeResult,
  CoreGraphClient,
  DefineTypeOptions,
  DynamicGraphClient,
  DynamicGraphMethods,
  DynamicRegistryConfig,
  EdgeTopology,
  ExpandParams,
  ExpandResult,
  FindEdgesParams,
  FindEdgesProjectedParams,
  FindNodesParams,
  GraphBatch,
  GraphClient,
  GraphClientOptions,
  GraphReader,
  GraphRegistry,
  GraphTransaction,
  MigrationExecutor,
  MigrationFn,
  MigrationWriteBack,
  ProjectedRow,
  QueryFilter,
  QueryOptions,
  ScanProtection,
  StoredGraphRecord,
} from './types.js';

const RESERVED_TYPE_NAMES = new Set([META_NODE_TYPE, META_EDGE_TYPE]);

function buildWritableNodeRecord(
  aType: string,
  uid: string,
  data: Record<string, unknown>,
): WritableRecord {
  return { aType, aUid: uid, axbType: NODE_RELATION, bType: aType, bUid: uid, data };
}

function buildWritableEdgeRecord(
  aType: string,
  aUid: string,
  axbType: string,
  bType: string,
  bUid: string,
  data: Record<string, unknown>,
): WritableRecord {
  return { aType, aUid, axbType, bType, bUid, data };
}

export class GraphClientImpl implements CoreGraphClient, DynamicGraphMethods {
  readonly scanProtection: ScanProtection;

  /**
   * Capability set of the underlying backend. Mirrors `backend.capabilities`
   * verbatim so callers can portability-check (`client.capabilities.has(
   * 'query.join')`) without reaching for the backend handle. Static for the
   * lifetime of the client.
   */
  get capabilities(): BackendCapabilities {
    return this.backend.capabilities;
  }

  // Static mode
  private readonly staticRegistry?: GraphRegistry;

  // Dynamic mode
  private readonly dynamicConfig?: DynamicRegistryConfig;
  private readonly bootstrapRegistry?: GraphRegistry;
  private dynamicRegistry?: GraphRegistry;
  private readonly metaBackend?: StorageBackend;

  // Migration settings
  private readonly globalWriteBack: MigrationWriteBack;
  private readonly migrationSandbox?: MigrationExecutor;

  constructor(
    private readonly backend: StorageBackend,
    options?: GraphClientOptions,
    /** @internal Optional pre-built meta-backend (used by subgraph clones). */
    metaBackend?: StorageBackend,
  ) {
    this.globalWriteBack = options?.migrationWriteBack ?? 'off';
    this.migrationSandbox = options?.migrationSandbox;

    if (options?.registryMode) {
      this.dynamicConfig = options.registryMode;
      this.bootstrapRegistry = createBootstrapRegistry();
      if (options.registry) {
        this.staticRegistry = options.registry;
      }
      this.metaBackend = metaBackend;
    } else {
      this.staticRegistry = options?.registry;
    }

    this.scanProtection = options?.scanProtection ?? 'error';
  }

  // ---------------------------------------------------------------------------
  // Backend access (exposed for traversal helpers and subgraph cloning)
  // ---------------------------------------------------------------------------

  /** @internal */
  getBackend(): StorageBackend {
    return this.backend;
  }

  /**
   * Snapshot of the currently-effective registry. Returns the merged view
   * used for domain-type validation and migration — in dynamic mode this is
   * `dynamicRegistry ?? staticRegistry ?? bootstrapRegistry`, so callers see
   * updates after `reloadRegistry()` without having to re-resolve anything.
   *
   * Exposed for backends that need topology access during bulk operations
   * (e.g. the Cloudflare DO backend's cross-DO cascade). Not part of the
   * public `GraphClient` surface.
   *
   * @internal
   */
  getRegistrySnapshot(): GraphRegistry | undefined {
    return this.getCombinedRegistry();
  }

  // ---------------------------------------------------------------------------
  // Registry routing
  // ---------------------------------------------------------------------------

  private getRegistryForType(aType: string): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;

    if (aType === META_NODE_TYPE || aType === META_EDGE_TYPE) {
      return this.bootstrapRegistry;
    }

    return this.dynamicRegistry ?? this.staticRegistry ?? this.bootstrapRegistry;
  }

  private getBackendForType(aType: string): StorageBackend {
    if (this.metaBackend && (aType === META_NODE_TYPE || aType === META_EDGE_TYPE)) {
      return this.metaBackend;
    }
    return this.backend;
  }

  private getCombinedRegistry(): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;
    return this.dynamicRegistry ?? this.staticRegistry ?? this.bootstrapRegistry;
  }

  // ---------------------------------------------------------------------------
  // Query safety
  // ---------------------------------------------------------------------------

  private checkQuerySafety(filters: QueryFilter[], allowCollectionScan?: boolean): void {
    if (allowCollectionScan || this.scanProtection === 'off') return;

    const result = analyzeQuerySafety(filters);
    if (result.safe) return;

    if (this.scanProtection === 'error') {
      throw new QuerySafetyError(result.reason!);
    }

    console.warn(`[firegraph] Query safety warning: ${result.reason}`);
  }

  // ---------------------------------------------------------------------------
  // Migration helpers
  // ---------------------------------------------------------------------------

  private async applyMigration(
    record: StoredGraphRecord,
    docId: string,
  ): Promise<StoredGraphRecord> {
    const registry = this.getCombinedRegistry();
    if (!registry) return record;

    const result = await migrateRecord(record, registry, this.globalWriteBack);
    if (result.migrated) {
      this.handleWriteBack(result, docId);
    }
    return result.record;
  }

  private async applyMigrations(records: StoredGraphRecord[]): Promise<StoredGraphRecord[]> {
    const registry = this.getCombinedRegistry();
    if (!registry || records.length === 0) return records;

    const results = await migrateRecords(records, registry, this.globalWriteBack);
    for (const result of results) {
      if (result.migrated) {
        const docId =
          result.record.axbType === NODE_RELATION
            ? computeNodeDocId(result.record.aUid)
            : computeEdgeDocId(result.record.aUid, result.record.axbType, result.record.bUid);
        this.handleWriteBack(result, docId);
      }
    }
    return results.map((r) => r.record);
  }

  /**
   * Fire-and-forget write-back for a migrated record. Both `'eager'` and
   * `'background'` are non-blocking; the difference is the log level on
   * failure. For synchronous write-back, use a transaction — see
   * `GraphTransactionImpl`.
   */
  private handleWriteBack(result: MigrationResult, docId: string): void {
    if (result.writeBack === 'off') return;

    const doWriteBack = async () => {
      try {
        await this.backend.updateDoc(docId, {
          replaceData: result.record.data as Record<string, unknown>,
          v: result.record.v,
        });
      } catch (err: unknown) {
        const msg = `[firegraph] Migration write-back failed for ${docId}: ${(err as Error).message}`;
        if (result.writeBack === 'eager') {
          console.error(msg);
        } else {
          console.warn(msg);
        }
      }
    };

    void doWriteBack();
  }

  // ---------------------------------------------------------------------------
  // GraphReader
  // ---------------------------------------------------------------------------

  async getNode(uid: string): Promise<StoredGraphRecord | null> {
    const docId = computeNodeDocId(uid);
    const record = await this.backend.getDoc(docId);
    if (!record) return null;
    return this.applyMigration(record, docId);
  }

  async getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.backend.getDoc(docId);
    if (!record) return null;
    return this.applyMigration(record, docId);
  }

  async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = await this.backend.getDoc(docId);
    return record !== null;
  }

  async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
    const plan = buildEdgeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.backend.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.backend.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
    const plan = buildNodeQueryPlan(params);
    let records: StoredGraphRecord[];
    if (plan.strategy === 'get') {
      const record = await this.backend.getDoc(plan.docId);
      records = record ? [record] : [];
    } else {
      this.checkQuerySafety(plan.filters, params.allowCollectionScan);
      records = await this.backend.query(plan.filters, plan.options);
    }
    return this.applyMigrations(records);
  }

  // ---------------------------------------------------------------------------
  // GraphWriter
  // ---------------------------------------------------------------------------

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    await this.writeNode(aType, uid, data, 'merge');
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'merge');
  }

  async replaceNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    await this.writeNode(aType, uid, data, 'replace');
  }

  async replaceEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.writeEdge(aType, aUid, axbType, bType, bUid, data, 'replace');
  }

  private async writeNode(
    aType: string,
    uid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): Promise<void> {
    assertNoDeleteSentinels(data, mode === 'replace' ? 'replaceNode' : 'putNode');
    const registry = this.getRegistryForType(aType);
    if (registry) {
      registry.validate(aType, NODE_RELATION, aType, data, this.backend.scopePath);
    }
    const backend = this.getBackendForType(aType);
    const docId = computeNodeDocId(uid);
    const record = buildWritableNodeRecord(aType, uid, data);
    if (registry) {
      const entry = registry.lookup(aType, NODE_RELATION, aType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        record.v = entry.schemaVersion;
      }
    }
    await backend.setDoc(docId, record, mode);
  }

  private async writeEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
    mode: 'merge' | 'replace',
  ): Promise<void> {
    assertNoDeleteSentinels(data, mode === 'replace' ? 'replaceEdge' : 'putEdge');
    const registry = this.getRegistryForType(aType);
    if (registry) {
      registry.validate(aType, axbType, bType, data, this.backend.scopePath);
    }
    const backend = this.getBackendForType(aType);
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = buildWritableEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    if (registry) {
      const entry = registry.lookup(aType, axbType, bType);
      if (entry?.schemaVersion && entry.schemaVersion > 0) {
        record.v = entry.schemaVersion;
      }
    }
    await backend.setDoc(docId, record, mode);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
  }

  async updateEdge(
    aUid: string,
    axbType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    await this.backend.updateDoc(docId, { dataOps: flattenPatch(data) });
  }

  async removeNode(uid: string): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.backend.deleteDoc(docId);
  }

  async removeEdge(aUid: string, axbType: string, bUid: string): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    await this.backend.deleteDoc(docId);
  }

  // ---------------------------------------------------------------------------
  // Transactions & Batches
  // ---------------------------------------------------------------------------

  async runTransaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T> {
    return this.backend.runTransaction(async (txBackend) => {
      const graphTx = new GraphTransactionImpl(
        txBackend,
        this.getCombinedRegistry(),
        this.scanProtection,
        this.backend.scopePath,
        this.globalWriteBack,
      );
      return fn(graphTx);
    });
  }

  batch(): GraphBatch {
    return new GraphBatchImpl(
      this.backend.createBatch(),
      this.getCombinedRegistry(),
      this.backend.scopePath,
    );
  }

  // ---------------------------------------------------------------------------
  // Subgraph
  // ---------------------------------------------------------------------------

  subgraph(parentNodeUid: string, name: string = 'graph'): GraphClient {
    if (!parentNodeUid || parentNodeUid.includes('/')) {
      throw new FiregraphError(
        `Invalid parentNodeUid for subgraph: "${parentNodeUid}". ` +
          'Must be a non-empty string without "/".',
        'INVALID_SUBGRAPH',
      );
    }
    if (name.includes('/')) {
      throw new FiregraphError(
        `Subgraph name must not contain "/": got "${name}". ` +
          'Use chained .subgraph() calls for nested subgraphs.',
        'INVALID_SUBGRAPH',
      );
    }

    const childBackend = this.backend.subgraph(parentNodeUid, name);

    return new GraphClientImpl(
      childBackend,
      {
        registry: this.getCombinedRegistry(),
        scanProtection: this.scanProtection,
        migrationWriteBack: this.globalWriteBack,
        migrationSandbox: this.migrationSandbox,
      },
      // Subgraphs do not have meta-backends; meta lives only at the root.
    );
  }

  // ---------------------------------------------------------------------------
  // Collection group query
  // ---------------------------------------------------------------------------

  async findEdgesGlobal(
    params: FindEdgesParams,
    collectionName?: string,
  ): Promise<StoredGraphRecord[]> {
    if (!this.backend.findEdgesGlobal) {
      throw new FiregraphError(
        'findEdgesGlobal() is not supported by the current storage backend.',
        'UNSUPPORTED_OPERATION',
      );
    }
    const plan = buildEdgeQueryPlan(params);
    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'findEdgesGlobal() requires a query, not a direct document lookup. ' +
          'Omit one of aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }
    this.checkQuerySafety(plan.filters, params.allowCollectionScan);
    const records = await this.backend.findEdgesGlobal(params, collectionName);
    return this.applyMigrations(records);
  }

  // ---------------------------------------------------------------------------
  // Aggregate query (capability: query.aggregate)
  // ---------------------------------------------------------------------------

  async aggregate<A extends AggregateSpec>(
    params: FindEdgesParams & { aggregates: A },
  ): Promise<AggregateResult<A>> {
    if (!this.backend.aggregate) {
      throw new FiregraphError(
        'aggregate() is not supported by the current storage backend.',
        'UNSUPPORTED_OPERATION',
      );
    }

    // Allow zero-filter aggregates (e.g. count(*) over the whole collection).
    // findEdges-style buildEdgeQueryPlan rejects empty filter sets because a
    // bare findEdges with no identifying fields would be a full collection
    // scan; aggregate() is the legitimate use case for that shape.
    const hasAnyFilter =
      params.aType ||
      params.aUid ||
      params.axbType ||
      params.bType ||
      params.bUid ||
      (params.where && params.where.length > 0);

    if (!hasAnyFilter) {
      this.checkQuerySafety([], params.allowCollectionScan);
      const result = await this.backend.aggregate(params.aggregates, []);
      return result as AggregateResult<A>;
    }

    const plan = buildEdgeQueryPlan(params);
    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'aggregate() requires a query, not a direct document lookup. ' +
          'Omit one of aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }
    this.checkQuerySafety(plan.filters, params.allowCollectionScan);
    const result = await this.backend.aggregate(params.aggregates, plan.filters);
    return result as AggregateResult<A>;
  }

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  async removeNodeCascade(uid: string, options?: BulkOptions): Promise<CascadeResult> {
    return this.backend.removeNodeCascade(uid, this, options);
  }

  async bulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult> {
    return this.backend.bulkRemoveEdges(params, this, options);
  }

  // ---------------------------------------------------------------------------
  // Server-side DML (capability: query.dml)
  // ---------------------------------------------------------------------------

  /**
   * Single-statement bulk DELETE. Translates `params` to a filter list via
   * `buildEdgeQueryPlan` (the same plan `findEdges` uses) and dispatches to
   * `backend.bulkDelete`. The fetch-then-delete loop in `bulkRemoveEdges`
   * is the cap-less fallback; this method is the fast path on backends
   * declaring `query.dml`.
   *
   * Scan-protection rules match `findEdges`: a query with no identifying
   * fields requires `allowCollectionScan: true` to pass. A bare-empty
   * filter set (no `aType`, `aUid`, etc., no `where`) is intentionally
   * allowed — backends that route `bulkDelete` to a per-subgraph DO need
   * "wipe this subgraph" as a legitimate shape, and the storage scope
   * inside the backend already bounds the blast radius.
   */
  async bulkDelete(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult> {
    if (!this.backend.bulkDelete) {
      throw new FiregraphError(
        'bulkDelete() is not supported by the current storage backend. ' +
          'Fall back to bulkRemoveEdges() for backends without query.dml ' +
          '(e.g. Firestore Standard).',
        'UNSUPPORTED_OPERATION',
      );
    }
    const filters = this.buildDmlFilters(params);
    return this.backend.bulkDelete(filters, options);
  }

  /**
   * Single-statement bulk UPDATE. Same translation path as `bulkDelete`,
   * but the patch is deep-merged into each matching row's `data` via the
   * shared `flattenPatch` pipeline. Identifying columns are immutable
   * through this path (see `BulkUpdatePatch` JSDoc).
   *
   * Empty-patch rejection happens inside the backend (`compileBulkUpdate`)
   * — a `data: {}` payload would only rewrite `updated_at`, which is
   * almost certainly a bug.
   */
  async bulkUpdate(
    params: FindEdgesParams,
    patch: BulkUpdatePatch,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    if (!this.backend.bulkUpdate) {
      throw new FiregraphError(
        'bulkUpdate() is not supported by the current storage backend.',
        'UNSUPPORTED_OPERATION',
      );
    }
    const filters = this.buildDmlFilters(params);
    return this.backend.bulkUpdate(filters, patch, options);
  }

  // ---------------------------------------------------------------------------
  // Multi-source fan-out (capability: query.join)
  // ---------------------------------------------------------------------------

  /**
   * Fan out from `params.sources` over a single edge type in one round trip.
   * On backends without `query.join`, throws `UNSUPPORTED_OPERATION` — the
   * cap-less fallback is the per-source `findEdges` loop, which lives in
   * `traverse.ts` (the higher-level traversal walker) rather than here.
   *
   * `expand()` is intentionally edge-type-only — the source set is a flat
   * UID list and the hop matches one `axbType`. Multi-axbType expansions
   * become multiple `expand()` calls, one per relation.
   *
   * `params.sources.length === 0` short-circuits to an empty result. The
   * backend never sees the call. (`compileExpand` itself rejects empty
   * because `IN ()` is not valid SQL.)
   */
  async expand(params: ExpandParams): Promise<ExpandResult> {
    if (!this.backend.expand) {
      throw new FiregraphError(
        'expand() is not supported by the current storage backend. ' +
          'Backends without `query.join` can use createTraversal() instead — ' +
          'the per-hop loop is functionally equivalent (just slower).',
        'UNSUPPORTED_OPERATION',
      );
    }
    if (params.sources.length === 0) {
      return params.hydrate ? { edges: [], targets: [] } : { edges: [] };
    }
    return this.backend.expand(params);
  }

  // ---------------------------------------------------------------------------
  // Server-side projection (capability: query.select)
  // ---------------------------------------------------------------------------

  /**
   * Server-side projection — fetch only the requested fields from each
   * matching edge. The backend translates the call into a projecting query
   * (`SELECT json_extract(...)` on SQLite/DO, `Query.select(...)` on
   * Firestore Standard, classic projection on Enterprise) so the wire
   * payload is reduced to just the requested fields.
   *
   * Resolution rules for `select` (mirrored across all backends):
   *
   *   - Built-in envelope fields (`aType`, `aUid`, `axbType`, `bType`,
   *     `bUid`, `createdAt`, `updatedAt`, `v`) → resolve to the typed
   *     column / Firestore field directly.
   *   - `'data'` literal → returns the whole user payload.
   *   - `'data.<x>'` → explicit nested path, returned at the same shape.
   *   - bare name → rewritten to `data.<name>` (the canonical "give me a
   *     few keys out of the JSON payload" shape).
   *
   * Empty `select: []` is rejected with `INVALID_QUERY`. Duplicate entries
   * are de-duped (first-occurrence order preserved); the result row carries
   * one slot per unique field.
   *
   * Migrations are *not* applied to the result. The caller asked for a
   * partial shape, and rehydrating it through the migration pipeline would
   * require synthesising every absent field — see
   * `StorageBackend.findEdgesProjected` for the rationale.
   *
   * Scan protection follows the `findEdges` rules: a query with no
   * identifying fields requires `allowCollectionScan: true` to pass. The
   * cap-less fallback would be `findEdges` + JS-side projection, but that
   * defeats the wire-payload reduction; backends without `query.select`
   * throw `UNSUPPORTED_OPERATION` rather than silently materialising full
   * rows.
   */
  async findEdgesProjected<F extends ReadonlyArray<string>>(
    params: FindEdgesProjectedParams<F>,
  ): Promise<Array<ProjectedRow<F>>> {
    if (!this.backend.findEdgesProjected) {
      throw new FiregraphError(
        'findEdgesProjected() is not supported by the current storage backend. ' +
          'There is no client-side fallback because the wire-payload reduction ' +
          'is the entire point of the API — use findEdges() and project in JS ' +
          'if the backend does not declare `query.select`.',
        'UNSUPPORTED_OPERATION',
      );
    }
    if (params.select.length === 0) {
      throw new FiregraphError(
        'findEdgesProjected() requires a non-empty `select` list.',
        'INVALID_QUERY',
      );
    }

    // Reuse the same plan + scan-safety pipeline as `findEdges` so the
    // identifier-vs-where rules and `allowCollectionScan` semantics behave
    // identically. A GET-shape (all three identifiers, no `where`) is also
    // allowed here — projection over a single edge is a meaningful shape.
    // We translate it to the equivalent equality filter list because the
    // backend `findEdgesProjected` contract takes filters, not a docId.
    const plan = buildEdgeQueryPlan(params);
    let filters: QueryFilter[];
    let options: QueryOptions | undefined;
    if (plan.strategy === 'get') {
      // GET means `aUid`, `axbType`, `bUid` are all set and there are no
      // `where` clauses. Synthesize the equivalent equality filters so the
      // backend can issue a single projecting query whose WHERE clause
      // resolves to the same row the docId would have looked up.
      filters = [
        { field: 'aUid', op: '==', value: params.aUid! },
        { field: 'axbType', op: '==', value: params.axbType! },
        { field: 'bUid', op: '==', value: params.bUid! },
      ];
      if (params.aType) filters.push({ field: 'aType', op: '==', value: params.aType });
      if (params.bType) filters.push({ field: 'bType', op: '==', value: params.bType });
      options = undefined;
    } else {
      filters = plan.filters;
      options = plan.options;
    }
    this.checkQuerySafety(filters, params.allowCollectionScan);
    const rows = await this.backend.findEdgesProjected(params.select, filters, options);
    return rows as Array<ProjectedRow<F>>;
  }

  /**
   * Translate a `FindEdgesParams` into the `QueryFilter[]` shape the
   * backend `bulkDelete` / `bulkUpdate` methods expect. Mirrors the
   * `aggregate()` plan: a bare-empty params object becomes an empty
   * filter list (after a scan-protection check); a GET-shape (all three
   * identifiers) is rejected so we never silently turn a single-row
   * lookup into a server-side DML; otherwise we run `buildEdgeQueryPlan`
   * and surface its filters.
   */
  private buildDmlFilters(params: FindEdgesParams): QueryFilter[] {
    const hasAnyFilter =
      params.aType ||
      params.aUid ||
      params.axbType ||
      params.bType ||
      params.bUid ||
      (params.where && params.where.length > 0);

    if (!hasAnyFilter) {
      this.checkQuerySafety([], params.allowCollectionScan);
      return [];
    }

    const plan = buildEdgeQueryPlan(params);
    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'bulkDelete() / bulkUpdate() require a query, not a direct document lookup. ' +
          'Use removeEdge() / updateEdge() for single-row operations, or omit one of ' +
          'aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }
    this.checkQuerySafety(plan.filters, params.allowCollectionScan);
    return plan.filters;
  }

  // ---------------------------------------------------------------------------
  // Dynamic registry methods
  // ---------------------------------------------------------------------------

  async defineNodeType(
    name: string,
    jsonSchema: object,
    description?: string,
    options?: DefineTypeOptions,
  ): Promise<void> {
    if (!this.dynamicConfig) {
      throw new DynamicRegistryError(
        'defineNodeType() is only available in dynamic registry mode. ' +
          'Pass registryMode: { mode: "dynamic" } to createGraphClient().',
      );
    }

    if (RESERVED_TYPE_NAMES.has(name)) {
      throw new DynamicRegistryError(
        `Cannot define type "${name}": this name is reserved for the meta-registry.`,
      );
    }

    if (this.staticRegistry?.lookup(name, NODE_RELATION, name)) {
      throw new DynamicRegistryError(
        `Cannot define node type "${name}": already defined in the static registry.`,
      );
    }

    const uid = generateDeterministicUid(META_NODE_TYPE, name);
    const data: Record<string, unknown> = { name, jsonSchema };
    if (description !== undefined) data.description = description;
    if (options?.titleField !== undefined) data.titleField = options.titleField;
    if (options?.subtitleField !== undefined) data.subtitleField = options.subtitleField;
    if (options?.viewTemplate !== undefined) data.viewTemplate = options.viewTemplate;
    if (options?.viewCss !== undefined) data.viewCss = options.viewCss;
    if (options?.allowedIn !== undefined) data.allowedIn = options.allowedIn;
    if (options?.migrationWriteBack !== undefined)
      data.migrationWriteBack = options.migrationWriteBack;
    if (options?.migrations !== undefined) {
      data.migrations = await this.serializeMigrations(options.migrations);
    }

    await this.putNode(META_NODE_TYPE, uid, data);
  }

  async defineEdgeType(
    name: string,
    topology: EdgeTopology,
    jsonSchema?: object,
    description?: string,
    options?: DefineTypeOptions,
  ): Promise<void> {
    if (!this.dynamicConfig) {
      throw new DynamicRegistryError(
        'defineEdgeType() is only available in dynamic registry mode. ' +
          'Pass registryMode: { mode: "dynamic" } to createGraphClient().',
      );
    }

    if (RESERVED_TYPE_NAMES.has(name)) {
      throw new DynamicRegistryError(
        `Cannot define type "${name}": this name is reserved for the meta-registry.`,
      );
    }

    if (this.staticRegistry) {
      const fromTypes = Array.isArray(topology.from) ? topology.from : [topology.from];
      const toTypes = Array.isArray(topology.to) ? topology.to : [topology.to];
      for (const aType of fromTypes) {
        for (const bType of toTypes) {
          if (this.staticRegistry.lookup(aType, name, bType)) {
            throw new DynamicRegistryError(
              `Cannot define edge type "${name}" for (${aType}) -> (${bType}): already defined in the static registry.`,
            );
          }
        }
      }
    }

    const uid = generateDeterministicUid(META_EDGE_TYPE, name);
    const data: Record<string, unknown> = {
      name,
      from: topology.from,
      to: topology.to,
    };
    if (jsonSchema !== undefined) data.jsonSchema = jsonSchema;
    if (topology.inverseLabel !== undefined) data.inverseLabel = topology.inverseLabel;
    if (topology.targetGraph !== undefined) data.targetGraph = topology.targetGraph;
    if (description !== undefined) data.description = description;
    if (options?.titleField !== undefined) data.titleField = options.titleField;
    if (options?.subtitleField !== undefined) data.subtitleField = options.subtitleField;
    if (options?.viewTemplate !== undefined) data.viewTemplate = options.viewTemplate;
    if (options?.viewCss !== undefined) data.viewCss = options.viewCss;
    if (options?.allowedIn !== undefined) data.allowedIn = options.allowedIn;
    if (options?.migrationWriteBack !== undefined)
      data.migrationWriteBack = options.migrationWriteBack;
    if (options?.migrations !== undefined) {
      data.migrations = await this.serializeMigrations(options.migrations);
    }

    await this.putNode(META_EDGE_TYPE, uid, data);
  }

  async reloadRegistry(): Promise<void> {
    if (!this.dynamicConfig) {
      throw new DynamicRegistryError(
        'reloadRegistry() is only available in dynamic registry mode. ' +
          'Pass registryMode: { mode: "dynamic" } to createGraphClient().',
      );
    }

    const reader = this.createMetaReader();
    const dynamicOnly = await createRegistryFromGraph(reader, this.migrationSandbox);

    if (this.staticRegistry) {
      this.dynamicRegistry = createMergedRegistry(this.staticRegistry, dynamicOnly);
    } else {
      this.dynamicRegistry = dynamicOnly;
    }
  }

  private async serializeMigrations(
    migrations: Array<{ fromVersion: number; toVersion: number; up: MigrationFn | string }>,
  ): Promise<Array<{ fromVersion: number; toVersion: number; up: string }>> {
    const result = migrations.map((m) => {
      const source = typeof m.up === 'function' ? m.up.toString() : m.up;
      return { fromVersion: m.fromVersion, toVersion: m.toVersion, up: source };
    });
    await Promise.all(result.map((m) => precompileSource(m.up, this.migrationSandbox)));
    return result;
  }

  /**
   * Build a `GraphReader` over the meta-backend. If meta lives in the same
   * collection as the main backend, `this` is returned directly.
   */
  private createMetaReader(): GraphReader {
    if (!this.metaBackend) return this;

    const backend = this.metaBackend;

    const executeMetaQuery = (
      filters: QueryFilter[],
      options?: QueryOptions,
    ): Promise<StoredGraphRecord[]> => backend.query(filters, options);

    return {
      async getNode(uid: string): Promise<StoredGraphRecord | null> {
        return backend.getDoc(computeNodeDocId(uid));
      },
      async getEdge(
        aUid: string,
        axbType: string,
        bUid: string,
      ): Promise<StoredGraphRecord | null> {
        return backend.getDoc(computeEdgeDocId(aUid, axbType, bUid));
      },
      async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
        const record = await backend.getDoc(computeEdgeDocId(aUid, axbType, bUid));
        return record !== null;
      },
      async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
        const plan = buildEdgeQueryPlan(params);
        if (plan.strategy === 'get') {
          const record = await backend.getDoc(plan.docId);
          return record ? [record] : [];
        }
        return executeMetaQuery(plan.filters, plan.options);
      },
      async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
        const plan = buildNodeQueryPlan(params);
        if (plan.strategy === 'get') {
          const record = await backend.getDoc(plan.docId);
          return record ? [record] : [];
        }
        return executeMetaQuery(plan.filters, plan.options);
      },
    };
  }
}

/**
 * Create a `GraphClient` backed by a `StorageBackend`.
 *
 * Phase 3: the type parameter `C` is inferred from
 * `StorageBackend<C>.capabilities` and propagates to the returned
 * `GraphClient<C>`. Extension surfaces (aggregate, search, raw escape
 * hatches, …) are conditionally intersected — they exist on the returned
 * type only when `C` declares the matching capability. Calls into
 * undeclared extensions are TypeScript errors at the call site, not
 * runtime failures.
 *
 * The runtime delegate `GraphClientImpl` carries only the portable core
 * methods today; extension methods land in Phases 4–10 alongside their
 * backend implementations. Until then the type-level surface is ahead of
 * the runtime, but no backend declares any extension capability so the
 * narrowing is effectively a no-op for current callers.
 *
 * `createGraphClientFromBackend` is retained as a deprecated alias for
 * backward compatibility while the codebase migrates off the old name.
 */
export function createGraphClient<C extends Capability = Capability>(
  backend: StorageBackend<C>,
  options: GraphClientOptions & { registryMode: DynamicRegistryConfig },
  metaBackend?: StorageBackend,
): DynamicGraphClient<C>;
export function createGraphClient<C extends Capability = Capability>(
  backend: StorageBackend<C>,
  options?: GraphClientOptions,
  metaBackend?: StorageBackend,
): GraphClient<C>;
export function createGraphClient<C extends Capability = Capability>(
  backend: StorageBackend<C>,
  options?: GraphClientOptions,
  metaBackend?: StorageBackend,
): GraphClient<C> | DynamicGraphClient<C> {
  // The double cast bridges the gap between the runtime delegate
  // (`GraphClientImpl`, which structurally implements
  // `CoreGraphClient & DynamicGraphMethods`) and the conditionally-
  // intersected return types `GraphClient<C>` / `DynamicGraphClient<C>`.
  // The implementation signature can't pick between the two overloads
  // without inspecting `options.registryMode` at the type level, which
  // requires conditional types over the `options` argument; the cast
  // collapses that ambiguity. Sound today because every `*Extension`
  // body is empty and `DynamicGraphMethods` is always present at runtime
  // (the validation routing inside `GraphClientImpl` no-ops the dynamic
  // methods when registryMode is absent).
  return new GraphClientImpl(backend, options, metaBackend) as unknown as
    | GraphClient<C>
    | DynamicGraphClient<C>;
}

/**
 * @deprecated Use `createGraphClient` instead. Kept temporarily so existing
 * callers (Cloudflare client, routing backend, tests) continue to compile
 * during the Phase 2 transition.
 */
export const createGraphClientFromBackend = createGraphClient;
