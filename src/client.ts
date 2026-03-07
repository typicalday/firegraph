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
import { DynamicRegistryError } from './errors.js';
import {
  createBootstrapRegistry,
  createRegistryFromGraph,
  generateDeterministicUid,
  META_NODE_TYPE,
  META_EDGE_TYPE,
} from './dynamic-registry.js';
import type {
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

  // Static mode
  private readonly staticRegistry?: GraphRegistry;

  // Dynamic mode
  private readonly dynamicConfig?: DynamicRegistryConfig;
  private readonly bootstrapRegistry?: GraphRegistry;
  private dynamicRegistry?: GraphRegistry;
  private readonly metaAdapter?: FirestoreAdapter;
  private readonly metaPipelineAdapter?: PipelineQueryAdapter;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    options?: GraphClientOptions,
  ) {
    this.adapter = createFirestoreAdapter(db, collectionPath);

    // Validate mutual exclusivity
    if (options?.registry && options?.registryMode) {
      throw new DynamicRegistryError(
        'Cannot provide both "registry" and "registryMode". ' +
        'Use "registry" for static mode or "registryMode" for dynamic mode.',
      );
    }

    if (options?.registryMode) {
      this.dynamicConfig = options.registryMode;
      this.bootstrapRegistry = createBootstrapRegistry();

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
   * - Static mode: returns staticRegistry (or undefined if none set)
   * - Dynamic mode:
   *   - Meta-types (nodeType, edgeType): validated against bootstrapRegistry
   *   - Domain types: validated against dynamicRegistry (falls back to
   *     bootstrapRegistry which rejects unknown types)
   */
  private getRegistryForType(aType: string): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;

    if (aType === META_NODE_TYPE || aType === META_EDGE_TYPE) {
      return this.bootstrapRegistry;
    }

    return this.dynamicRegistry ?? this.bootstrapRegistry;
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
   * In static mode, returns staticRegistry.
   * In dynamic mode, returns dynamicRegistry (which includes bootstrap entries)
   * or bootstrapRegistry if not yet reloaded.
   */
  private getCombinedRegistry(): GraphRegistry | undefined {
    if (!this.dynamicConfig) return this.staticRegistry;
    return this.dynamicRegistry ?? this.bootstrapRegistry;
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
    return this.executeQuery(plan.filters, plan.options);
  }

  async findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]> {
    const plan = buildNodeQueryPlan(params);
    if (plan.strategy === 'get') {
      const record = await this.adapter.getDoc(plan.docId);
      return record ? [record] : [];
    }
    return this.executeQuery(plan.filters, plan.options);
  }

  // ---------------------------------------------------------------------------
  // GraphWriter
  // ---------------------------------------------------------------------------

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    const registry = this.getRegistryForType(aType);
    if (registry) {
      registry.validate(aType, NODE_RELATION, aType, data);
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
      registry.validate(aType, axbType, bType, data);
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
      const graphTx = new GraphTransactionImpl(adapter, this.getCombinedRegistry());
      return fn(graphTx);
    });
  }

  batch(): GraphBatch {
    const adapter = createBatchAdapter(this.db, this.adapter.collectionPath);
    return new GraphBatchImpl(adapter, this.getCombinedRegistry());
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

    const uid = generateDeterministicUid(META_NODE_TYPE, name);
    const data: Record<string, unknown> = { name, jsonSchema };
    if (description !== undefined) data.description = description;

    await this.putNode(META_NODE_TYPE, uid, data);
  }

  async defineEdgeType(
    name: string,
    topology: EdgeTopology,
    jsonSchema?: object,
    description?: string,
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

    const uid = generateDeterministicUid(META_EDGE_TYPE, name);
    const data: Record<string, unknown> = {
      name,
      from: topology.from,
      to: topology.to,
    };
    if (jsonSchema !== undefined) data.jsonSchema = jsonSchema;
    if (topology.inverseLabel !== undefined) data.inverseLabel = topology.inverseLabel;
    if (description !== undefined) data.description = description;

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
    this.dynamicRegistry = await createRegistryFromGraph(reader);
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
  return new GraphClientImpl(db, collectionPath, options);
}
