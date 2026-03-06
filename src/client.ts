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
import { createPipelineQueryAdapter } from './internal/pipeline-adapter.js';
import type { PipelineQueryAdapter } from './internal/pipeline-adapter.js';
import { GraphTransactionImpl } from './transaction.js';
import { GraphBatchImpl } from './batch.js';
import {
  removeNodeCascade as removeNodeCascadeImpl,
  bulkRemoveEdges as bulkRemoveEdgesImpl,
} from './bulk.js';
import type {
  GraphClient,
  GraphClientOptions,
  GraphRegistry,
  GraphTransaction,
  GraphBatch,
  StoredGraphRecord,
  FindEdgesParams,
  FindNodesParams,
  QueryFilter,
  QueryOptions,
  QueryMode,
  BulkOptions,
  BulkResult,
  CascadeResult,
} from './types.js';

let _standardModeWarned = false;

class GraphClientImpl implements GraphClient {
  private readonly adapter;
  private readonly pipelineAdapter?: PipelineQueryAdapter;
  private readonly queryMode: QueryMode;
  private readonly registry?: GraphRegistry;

  constructor(
    private readonly db: Firestore,
    collectionPath: string,
    options?: GraphClientOptions,
  ) {
    this.adapter = createFirestoreAdapter(db, collectionPath);
    this.registry = options?.registry;

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
    }
  }

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

  async putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void> {
    if (this.registry) {
      this.registry.validate(aType, NODE_RELATION, aType, data);
    }
    const docId = computeNodeDocId(uid);
    const record = buildNodeRecord(aType, uid, data);
    await this.adapter.setDoc(docId, record as unknown as Record<string, unknown>);
  }

  async putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (this.registry) {
      this.registry.validate(aType, axbType, bType, data);
    }
    const docId = computeEdgeDocId(aUid, axbType, bUid);
    const record = buildEdgeRecord(aType, aUid, axbType, bType, bUid, data);
    await this.adapter.setDoc(docId, record as unknown as Record<string, unknown>);
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

  async runTransaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (firestoreTx) => {
      const adapter = createTransactionAdapter(
        this.db,
        this.adapter.collectionPath,
        firestoreTx,
      );
      // Transactions always use standard queries — Pipeline is not transactionally bound
      const graphTx = new GraphTransactionImpl(adapter, this.registry);
      return fn(graphTx);
    });
  }

  batch(): GraphBatch {
    const adapter = createBatchAdapter(this.db, this.adapter.collectionPath);
    return new GraphBatchImpl(adapter, this.registry);
  }

  async removeNodeCascade(uid: string, options?: BulkOptions): Promise<CascadeResult> {
    return removeNodeCascadeImpl(this.db, this.adapter.collectionPath, this, uid, options);
  }

  async bulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult> {
    return bulkRemoveEdgesImpl(this.db, this.adapter.collectionPath, this, params, options);
  }
}

export function createGraphClient(
  db: Firestore,
  collectionPath: string,
  options?: GraphClientOptions,
): GraphClient {
  return new GraphClientImpl(db, collectionPath, options);
}
