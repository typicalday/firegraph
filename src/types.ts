import type { Timestamp, FieldValue, WhereFilterOp } from '@google-cloud/firestore';

export interface GraphRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

export interface StoredGraphRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface WhereClause {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=';
  value: unknown;
}

export interface FindEdgesParams {
  aType?: string;
  aUid?: string;
  axbType?: string;
  bType?: string;
  bUid?: string;
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  where?: WhereClause[];
}

export interface FindNodesParams {
  aType: string;
}

export interface QueryOptions {
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
}

export type QueryPlan =
  | { strategy: 'get'; docId: string }
  | { strategy: 'query'; filters: QueryFilter[]; options?: QueryOptions };

export interface QueryFilter {
  field: string;
  op: WhereFilterOp;
  value: unknown;
}

export interface RegistryEntry {
  aType: string;
  axbType: string;
  bType: string;
  /** JSON Schema object for the data payload. */
  jsonSchema?: object;
  description?: string;
  inverseLabel?: string;
}

// ---------------------------------------------------------------------------
// Entity Discovery Types
// ---------------------------------------------------------------------------

/** Topology declaration for an edge (from edge.json). */
export interface EdgeTopology {
  from: string | string[];
  to: string | string[];
  inverseLabel?: string;
}

/** A discovered entity from the per-entity folder convention. */
export interface DiscoveredEntity {
  kind: 'node' | 'edge';
  name: string;
  /** Parsed JSON Schema for the data payload. */
  schema: object;
  /** Edge topology (only for edges). */
  topology?: EdgeTopology;
  description?: string;
  /** View defaults from meta.json. */
  viewDefaults?: import('./config.js').ViewResolverConfig;
  /** Absolute path to views.ts if present. */
  viewsPath?: string;
  /** Sample data from sample.json. */
  sampleData?: Record<string, unknown>;
}

/** Result of scanning an entities directory. */
export interface DiscoveryResult {
  nodes: Map<string, DiscoveredEntity>;
  edges: Map<string, DiscoveredEntity>;
}

/** Controls which Firestore query backend is used. */
export type QueryMode = 'pipeline' | 'standard';

/**
 * Configuration for dynamic registry mode where type definitions
 * are stored as graph data (meta-nodes) rather than in code.
 */
export interface DynamicRegistryConfig {
  mode: 'dynamic';
  /**
   * Collection path for meta-type nodes (`nodeType`, `edgeType`).
   * Defaults to the main `collectionPath` if omitted.
   */
  collection?: string;
}

/** Data shape stored in a `nodeType` meta-node. */
export interface NodeTypeData {
  name: string;
  jsonSchema: object;
  description?: string;
}

/** Data shape stored in an `edgeType` meta-node. */
export interface EdgeTypeData {
  name: string;
  from: string | string[];
  to: string | string[];
  jsonSchema?: object;
  inverseLabel?: string;
  description?: string;
}

export interface GraphClientOptions {
  /** Static registry built from code/discovery. Ignored if registryMode is set. */
  registry?: GraphRegistry;
  /** Dynamic registry mode — type definitions stored as graph data. */
  registryMode?: DynamicRegistryConfig;
  /**
   * Query execution backend.
   *
   * - `'pipeline'` (default) — Uses Firestore Pipeline API. Requires Enterprise
   *   Firestore. Enables indexless queries on `data.*` fields.
   * - `'standard'` — Uses standard Firestore `.where().get()` queries. Requires
   *   composite indexes for `data.*` filters or risks full collection scans
   *   (Enterprise) / query failures (Standard Firestore).
   *
   * When `FIRESTORE_EMULATOR_HOST` is set, the client auto-falls back to
   * `'standard'` regardless of this setting (emulator doesn't support pipelines).
   */
  queryMode?: QueryMode;
}

export interface GraphRegistry {
  validate(aType: string, axbType: string, bType: string, data: unknown): void;
  lookup(aType: string, axbType: string, bType: string): RegistryEntry | undefined;
  entries(): ReadonlyArray<RegistryEntry>;
}

export interface GraphReader {
  getNode(uid: string): Promise<StoredGraphRecord | null>;
  getEdge(aUid: string, axbType: string, bUid: string): Promise<StoredGraphRecord | null>;
  edgeExists(aUid: string, axbType: string, bUid: string): Promise<boolean>;
  findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]>;
  findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]>;
}

export interface GraphWriter {
  putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void>;
  putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  updateNode(uid: string, data: Record<string, unknown>): Promise<void>;
  removeNode(uid: string): Promise<void>;
  removeEdge(aUid: string, axbType: string, bUid: string): Promise<void>;
}

export interface GraphClient extends GraphReader, GraphWriter {
  runTransaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T>;
  batch(): GraphBatch;
  /** Delete a node and all its outgoing/incoming edges in chunked batches. */
  removeNodeCascade(uid: string, options?: BulkOptions): Promise<CascadeResult>;
  /** Find all edges matching `params` and delete them in chunked batches. */
  bulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult>;
}

export interface DynamicGraphClient extends GraphClient {
  /** Define or update a node type in the dynamic registry. */
  defineNodeType(
    name: string,
    jsonSchema: object,
    description?: string,
  ): Promise<void>;

  /** Define or update an edge type in the dynamic registry. */
  defineEdgeType(
    name: string,
    topology: EdgeTopology,
    jsonSchema?: object,
    description?: string,
  ): Promise<void>;

  /** Reload the registry from meta-type nodes in the graph. */
  reloadRegistry(): Promise<void>;
}

export interface GraphTransaction extends GraphReader, GraphWriter {}

export interface GraphBatch extends GraphWriter {
  commit(): Promise<void>;
}

export interface HopDefinition {
  axbType: string;
  direction?: 'forward' | 'reverse';
  aType?: string;
  bType?: string;
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  filter?: (edge: StoredGraphRecord) => boolean;
}

export interface TraversalOptions {
  maxReads?: number;
  concurrency?: number;
  returnIntermediates?: boolean;
}

export interface HopResult {
  axbType: string;
  depth: number;
  edges: StoredGraphRecord[];
  sourceCount: number;
  truncated: boolean;
}

export interface TraversalResult {
  nodes: StoredGraphRecord[];
  hops: HopResult[];
  totalReads: number;
  truncated: boolean;
}

export interface TraversalBuilder {
  follow(axbType: string, options?: Omit<HopDefinition, 'axbType'>): TraversalBuilder;
  run(options?: TraversalOptions): Promise<TraversalResult>;
}

// ---------------------------------------------------------------------------
// Bulk Operation Types
// ---------------------------------------------------------------------------

export interface BulkOptions {
  /** Max operations per Firestore batch (default 500, Firestore hard limit). */
  batchSize?: number;
  /** Number of retry attempts per failed batch (default 3). */
  maxRetries?: number;
  /** Called after each batch commits. */
  onProgress?: (progress: BulkProgress) => void;
}

export interface BulkProgress {
  /** Batches committed so far. */
  completedBatches: number;
  /** Total batches planned. */
  totalBatches: number;
  /** Total documents deleted so far. */
  deletedSoFar: number;
}

export interface BulkResult {
  /** Total documents successfully deleted. */
  deleted: number;
  /** Number of batches committed. */
  batches: number;
  /** Errors from batches that failed after all retries. */
  errors: BulkBatchError[];
}

export interface BulkBatchError {
  /** Zero-based index of the failed batch. */
  batchIndex: number;
  /** The underlying error. */
  error: Error;
  /** Number of operations in this batch that were not applied. */
  operationCount: number;
}

export interface CascadeResult extends BulkResult {
  /** Number of edges deleted. */
  edgesDeleted: number;
  /** Whether the node itself was deleted. */
  nodeDeleted: boolean;
}
