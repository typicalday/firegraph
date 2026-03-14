import { FieldValue } from '@google-cloud/firestore';
import type { Firestore } from '@google-cloud/firestore';
import { computeNodeDocId, computeEdgeDocId } from './docid.js';
import { buildNodeRecord, buildEdgeRecord } from './record.js';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
import { NODE_RELATION } from './internal/constants.js';
import {
  createFirestoreAdapter,
  createTransactionAdapter,
  createBatchAdapter,
} from './internal/firestore-adapter.js';
import type { FirestoreAdapter } from './internal/firestore-adapter.js';
import { createPipelineQueryAdapter } from './internal/pipeline-adapter.js';
import type { PipelineQueryAdapter } from './internal/pipeline-adapter.js';
import { GraphTransactionImpl } from './transaction.js';
import { GraphBatchImpl } from './batch.js';
import {
  removeNodeCascade as removeNodeCascadeImpl,
  bulkRemoveEdges as bulkRemoveEdgesImpl,
} from './bulk.js';
import { DynamicRegistryError, FiregraphError, QuerySafetyError } from './errors.js';
import { analyzeQuerySafety } from './query-safety.js';
import {
  createBootstrapRegistry,
  createRegistryFromGraph,
  generateDeterministicUid,
  META_NODE_TYPE,
  META_EDGE_TYPE,
} from './dynamic-registry.js';
import { createMergedRegistry } from './registry.js';
import type {
  DefineTypeOptions,
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
  GraphReader,
  GraphRegistry,
  GraphTransaction,
  GraphBatch,
  StoredGraphRecord,
  FindEdgesParams,
  FindNodesParams,
  EdgeTopology,
  QueryFilter,
  QueryOptions,
  QueryMode,
  ScanProtection,
  BulkOptions,
  BulkResult,
  CascadeResult,
} from './types.js';

let _standardModeWarned = false;

const RESERVED_TYPE_NAMES = new Set([META_NODE_TYPE, META_EDGE_TYPE]);

class GraphClientImpl implements DynamicGraphClient {
  private readonly adapter: FirestoreAdapter;
  private readonly pipelineAdapter?: PipelineQueryAdapter;
  private readonly queryMode: QueryMode;
  readonly scanProtection: ScanProtection;

  // Static mode
  private readonly staticRegistry?: GraphRegistry;

  // Dynamic mode
  private readonly dynamicConfig?: DynamicRegistryConfig;
  private readonly bootstrapRegistry?: GraphRegistry;
  private dynamicRegistry?: GraphRegistry;
  private readonly metaAdapter?: FirestoreAdapter;
  private readonly metaPipelineAdapter?: PipelineQueryAdapter;

  // Subgraph scope tracking
  private readonly scopePath: string;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    options?: GraphClientOptions,
    /** @internal Scope path for subgraph clients (empty string = root). */
    scopePath: string = '',
  ) {
    this.scopePath = scopePath;
    this.adapter = createFirestoreAdapter(db, collectionPath);

    if (options?.registryMode) {
      this.dynamicConfig = options.registryMode;
      this.bootstrapRegistry = createBootstrapRegistry();

      // Merged mode: static registry provided alongside dynamic config.
      // Static entries take priority; dynamic can only add new types.
      if (options.registry) {
        this.staticRegistry = options.registry;
      }

      // If meta-collection differs from main, create separate adapter
      const metaCollectionPath = options.registryMode.collection;
      if (metaCollectionPath && metaCollectionPath !== collectionPath) {
        this.metaAdapter = createFirestoreAdapter(db, metaCollectionPath);
      }
    } else {
      this.staticRegistry = options?.registry;
    }

    // Resolve effective query mode
    const requestedMode = options?.queryMode ?? 'pipeline';
    const isEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;

    if (isEmulator) {
      // Emulator doesn't support Pipeline operations — silently fall back
      this.queryMode = 'standard';
    } else {
      this.queryMode = requestedMode;
    }

    // Warn once when standard mode is explicitly chosen outside the emulator
    if (
      this.queryMode === 'standard' &&
      !isEmulator &&
      requestedMode === 'standard' &&
      !_standardModeWarned
    ) {
      _standardModeWarned = true;
      console.warn(
        '[firegraph] Standard query mode enabled. This is NOT recommended for production:\n' +
        '  - Enterprise Firestore: data.* filters cause full collection scans (high billing)\n' +
        '  - Standard Firestore: data.* filters without composite indexes will fail\n' +
        '  See: https://github.com/typicalday/firegraph#query-modes',
      );
    }

    // Scan protection
    this.scanProtection = options?.scanProtection ?? 'error';

    // Create pipeline adapter when in pipeline mode
    if (this.queryMode === 'pipeline') {
      this.pipelineAdapter = createPipelineQueryAdapter(db, collectionPath);

      // Also create pipeline adapter for meta-collection if separate
      if (this.metaAdapter) {
        this.metaPipelineAdapter = createPipelineQueryAdapter(
          db,
          options!.registryMode!.collection!,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Registry routing
  // ---------------------------------------------------------------------------

  /**
   * Get the appropriate registry for validating a write to the given type.
   *
   * - Static-only mode: returns staticRegistry (or undefined if none set)
   * - Dynamic mode (pure or merged):
   *   - Meta-types (nodeType, edgeType): validated against bootstrapRegistry
   *   - Domain types: validated against dynamicRegistry (falls back to
   *     bootstrapRegistry which rejects unknown types)
   *   - Merged mode: dynamicRegistry is a merged wrapper (static + dynamic
   *     extension), so static entries take priority automatically.
   */
  private getRegistryForType(aType: string): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;

    if (aType === META_NODE_TYPE || aType === META_EDGE_TYPE) {
      return this.bootstrapRegistry;
    }

    return this.dynamicRegistry ?? this.staticRegistry ?? this.bootstrapRegistry;
  }

  /**
   * Get the Firestore adapter for writing the given type.
   * Meta-types route to metaAdapter if a separate collection is configured.
   */
  private getAdapterForType(aType: string): FirestoreAdapter {
    if (
      this.metaAdapter &&
      (aType === META_NODE_TYPE || aType === META_EDGE_TYPE)
    ) {
      return this.metaAdapter;
    }
    return this.adapter;
  }

  /**
   * Get the combined registry for transaction/batch context.
   * In static-only mode, returns staticRegistry.
   * In dynamic mode, returns dynamicRegistry (which includes bootstrap entries)
   * or falls back to staticRegistry (merged mode) or bootstrapRegistry.
   */
  private getCombinedRegistry(): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;
    return this.dynamicRegistry ?? this.staticRegistry ?? this.bootstrapRegistry;
  }

  // ---------------------------------------------------------------------------
  // Query dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a query to the appropriate adapter based on queryMode.
   * Pipeline queries use the PipelineQueryAdapter; standard queries
   * use the FirestoreAdapter.
   */
  private executeQuery(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    if (this.pipelineAdapter) {
      return this.pipelineAdapter.query(filters, options);
    }
    return this.adapter.query(filters, options);
  }

  /**
   * Check whether a query's filter set is safe (matches a known index pattern).
   * Throws QuerySafetyError or logs a warning depending on scanProtection config.
   */
  private checkQuerySafety(filters: QueryFilter[], allowCollectionScan?: boolean): void {
    if (allowCollectionScan || this.scanProtection === 'off') return;

    const result = analyzeQuerySafety(filters);
    if (result.safe) return;

    if (this.scanProtection === 'error') {
      throw new QuerySafetyError(result.reason!);
    }

    // scanProtection === 'warn'
    console.warn(`[firegraph] Query safety warning: ${result.reason}`);
  }

  // ---------------------------------------------------------------------------
  // GraphReader
  // ---------------------------------------------------------------------------

  async getNode(uid: string): Promise<StoredGraphRecord | null> {
    const docId = computeNodeDocId(uid);
    return this.adapter.getDoc(docId);
  }

  async getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    return this.adapter.getDoc(docId);
  }

  async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
    const record = await this.getEdge(aUid, axbType, bUid);
    return record !== null;
  }

  async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
    const plan = buildEdgeQueryPlan(params);
    if (plan.strategy === 'get') {
      const record = await this.adapter.getDoc(plan.docId);
      return record ? [record] : [];
    }
    this.checkQuerySafety(plan.filters, params.allowCollectionScan);
    return this.executeQuery(plan.filters, plan.options);
  }

  async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
    const plan = buildNodeQueryPlan(params);
    if (plan.strategy === 'get') {
      const record = await this.adapter.getDoc(plan.docId);
      return record ? [record] : [];
    }
    this.checkQuerySafety(plan.filters, params.allowCollectionScan);
    return this.executeQuery(plan.filters, plan.options);
  }

  // ---------------------------------------------------------------------------
  // GraphWriter
  // ---------------------------------------------------------------------------

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    const registry = this.getRegistryForType(aType);
    if (registry) {
      registry.validate(aType, NODE_RELATION, aType, data, this.scopePath);
    }
    const adapter = this.getAdapterForType(aType);
    const docId = computeNodeDocId(uid);
    const record = buildNodeRecord(aType, uid, data);
    await adapter.setDoc(docId, record as unknown as Record<string, unknown>);
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const registry = this.getRegistryForType(aType);
    if (registry) {
      registry.validate(aType, axbType, bType, data, this.scopePath);
    }
    const adapter = this.getAdapterForType(aType);
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = buildEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    await adapter.setDoc(docId, record as unknown as Record<string, unknown>);
  }

  async updateNode(uid: string, data: Record<string, unknown>): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.adapter.updateDoc(docId, {
      ...data,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async removeNode(uid: string): Promise<void> {
    const docId = computeNodeDocId(uid);
    await this.adapter.deleteDoc(docId);
  }

  async removeEdge(aUid: string, axbType: string, bUid: string): Promise<void> {
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    await this.adapter.deleteDoc(docId);
  }

  // ---------------------------------------------------------------------------
  // Transactions & Batches
  // ---------------------------------------------------------------------------

  async runTransaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (firestoreTx) => {
      const adapter = createTransactionAdapter(
        this.db,
        this.adapter.collectionPath,
        firestoreTx,
      );
      // Transactions always use standard queries — Pipeline is not transactionally bound
      const graphTx = new GraphTransactionImpl(adapter, this.getCombinedRegistry(), this.scanProtection, this.scopePath);
      return fn(graphTx);
    });
  }

  batch(): GraphBatch {
    const adapter = createBatchAdapter(this.db, this.adapter.collectionPath);
    return new GraphBatchImpl(adapter, this.getCombinedRegistry(), this.scopePath);
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
    const subCollectionPath = `${this.adapter.collectionPath}/${parentNodeUid}/${name}`;
    const newScopePath = this.scopePath ? `${this.scopePath}/${name}` : name;

    return new GraphClientImpl(
      this.db,
      subCollectionPath,
      {
        registry: this.getCombinedRegistry(),
        queryMode: this.queryMode === 'pipeline' ? 'pipeline' : 'standard',
        scanProtection: this.scanProtection,
      },
      newScopePath,
    );
  }

  // ---------------------------------------------------------------------------
  // Collection group query
  // ---------------------------------------------------------------------------

  async findEdgesGlobal(
    params: FindEdgesParams,
    collectionName?: string,
  ): Promise<StoredGraphRecord[]> {
    const name = collectionName ?? this.adapter.collectionPath.split('/').pop()!;
    const plan = buildEdgeQueryPlan(params);

    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'findEdgesGlobal() requires a query, not a direct document lookup. ' +
        'Omit one of aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }

    this.checkQuerySafety(plan.filters, params.allowCollectionScan);

    // Use Firestore collection group query
    const collectionGroupRef = this.db.collectionGroup(name);
    let q: import('@google-cloud/firestore').Query = collectionGroupRef;
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

  // ---------------------------------------------------------------------------
  // Bulk operations
  // ---------------------------------------------------------------------------

  async removeNodeCascade(uid: string, options?: BulkOptions): Promise<CascadeResult> {
    return removeNodeCascadeImpl(this.db, this.adapter.collectionPath, this, uid, options);
  }

  async bulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult> {
    return bulkRemoveEdgesImpl(this.db, this.adapter.collectionPath, this, params, options);
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

    // Merged mode: reject if static registry already defines this node type
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

    // Merged mode: reject if static registry already defines any triple for this edge
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
    const dynamicOnly = await createRegistryFromGraph(reader);

    if (this.staticRegistry) {
      // Merged mode: static entries take priority over dynamic ones
      this.dynamicRegistry = createMergedRegistry(this.staticRegistry, dynamicOnly);
    } else {
      this.dynamicRegistry = dynamicOnly;
    }
  }

  /**
   * Create a GraphReader for the meta-collection.
   * If meta-collection is the same as main collection, returns `this`.
   * If separate, creates a lightweight reader wrapping the meta adapter.
   */
  private createMetaReader(): GraphReader {
    if (!this.metaAdapter) return this;

    const adapter = this.metaAdapter;
    const pipelineAdapter = this.metaPipelineAdapter;

    const executeMetaQuery = (
      filters: QueryFilter[],
      options?: QueryOptions,
    ): Promise<StoredGraphRecord[]> => {
      if (pipelineAdapter) return pipelineAdapter.query(filters, options);
      return adapter.query(filters, options);
    };

    return {
      async getNode(uid: string): Promise<StoredGraphRecord | null> {
        return adapter.getDoc(computeNodeDocId(uid));
      },
      async getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null> {
        return adapter.getDoc(computeEdgeDocId(aUid, axbType, bUid));
      },
      async edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean> {
        const record = await adapter.getDoc(computeEdgeDocId(aUid, axbType, bUid));
        return record !== null;
      },
      async findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]> {
        const plan = buildEdgeQueryPlan(params);
        if (plan.strategy === 'get') {
          const record = await adapter.getDoc(plan.docId);
          return record ? [record] : [];
        }
        return executeMetaQuery(plan.filters, plan.options);
      },
      async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
        const plan = buildNodeQueryPlan(params);
        if (plan.strategy === 'get') {
          const record = await adapter.getDoc(plan.docId);
          return record ? [record] : [];
        }
        return executeMetaQuery(plan.filters, plan.options);
      },
    };
  }
}

export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options: GraphClientOptions & { registryMode: DynamicRegistryConfig },
): DynamicGraphClient;
export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options?: GraphClientOptions,
): GraphClient;
export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options?: GraphClientOptions,
): GraphClient | DynamicGraphClient {
  return new GraphClientImpl(db, collectionPath, options) as GraphClient | DynamicGraphClient;
}
