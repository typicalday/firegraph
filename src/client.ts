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
import type { StorageBackend, WritableRecord } from './internal/backend.js';
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
  BulkOptions,
  BulkResult,
  Capability,
  CascadeResult,
  CoreGraphClient,
  DefineTypeOptions,
  DynamicGraphClient,
  DynamicGraphMethods,
  DynamicRegistryConfig,
  EdgeTopology,
  FindEdgesParams,
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
  // Bulk operations
  // ---------------------------------------------------------------------------

  async removeNodeCascade(uid: string, options?: BulkOptions): Promise<CascadeResult> {
    return this.backend.removeNodeCascade(uid, this, options);
  }

  async bulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult> {
    return this.backend.bulkRemoveEdges(params, this, options);
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
