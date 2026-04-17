import type { FieldValue, Timestamp, WhereFilterOp } from '@google-cloud/firestore';

import type { ViewResolverConfig } from './config.js';
import type { GraphTimestamp } from './timestamp.js';

export interface GraphRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
  /** Schema version — set automatically when the registry entry has migrations. */
  v?: number;
}

export interface StoredGraphRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  /**
   * Backend-agnostic timestamp. Firestore returns its native `Timestamp`
   * (which structurally satisfies `GraphTimestamp`); the SQLite backends
   * return a `GraphTimestampImpl` instance.
   */
  createdAt: GraphTimestamp;
  updatedAt: GraphTimestamp;
  /** Schema version — set automatically when the registry entry has migrations. */
  v?: number;
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
  /** Set to true to allow queries that may cause full collection scans. */
  allowCollectionScan?: boolean;
}

export interface FindNodesParams {
  aType: string;
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  where?: WhereClause[];
  /** Set to true to allow queries that may cause full collection scans. */
  allowCollectionScan?: boolean;
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

// ---------------------------------------------------------------------------
// Migration Types
// ---------------------------------------------------------------------------

/**
 * An executable migration function that transforms data from one schema
 * version to the next. Can be synchronous or asynchronous.
 */
export type MigrationFn = (
  data: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * A single migration step in a registry entry.
 * Transforms data from `fromVersion` to `toVersion`.
 */
export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  up: MigrationFn;
}

/**
 * A stored migration step for dynamic registry types.
 * The `up` field is a source code string that will be compiled at runtime.
 *
 * @example
 * ```ts
 * { fromVersion: 0, toVersion: 1, up: "(data) => ({ ...data, status: 'draft' })" }
 * ```
 */
export interface StoredMigrationStep {
  fromVersion: number;
  toVersion: number;
  up: string;
}

/**
 * Pluggable executor interface for compiling migration function source
 * strings into executable functions. Used for dynamic registry migrations.
 *
 * The default executor uses SES (Secure ECMAScript) Compartments with
 * JSON marshaling for isolation. Users can supply an alternative via
 * `GraphClientOptions.migrationSandbox`.
 */
export type MigrationExecutor = (source: string) => MigrationFn;

/** Write-back mode for auto-migrated records. */
export type MigrationWriteBack = 'off' | 'eager' | 'background';

export interface RegistryEntry {
  aType: string;
  axbType: string;
  bType: string;
  /** JSON Schema object for the data payload. */
  jsonSchema?: object;
  description?: string;
  inverseLabel?: string;
  /** Data field to use as the display title (e.g. 'name', 'date'). */
  titleField?: string;
  /** Data field to use as the display subtitle (e.g. 'status', 'difficulty'). */
  subtitleField?: string;
  /**
   * Scope patterns constraining where this type can exist.
   * Omit or leave empty to allow everywhere (backwards compatible).
   *
   * Patterns:
   *   - `'root'`            — top-level collection only
   *   - `'agents'`          — exact subgraph name match
   *   - `'workflow/agents'`  — exact path match
   *   - `'*​/agents'`        — `*` matches one segment
   *   - `'**​/agents'`       — `**` matches zero or more segments
   */
  allowedIn?: string[];
  /**
   * Subgraph name where cross-graph edges of this type live.
   *
   * When set, forward traversal queries the named subgraph under each
   * source node (e.g., `{collection}/{sourceUid}/{targetGraph}`) instead
   * of the current collection. The subgraph contains both the edge
   * documents and the target nodes they reference.
   *
   * Reverse traversal is unaffected — if you're already in the subgraph,
   * the edges are local.
   *
   * Only applies to edge entries (not node self-loop entries).
   * Must be a single segment (no `/`).
   *
   * @example
   * ```ts
   * { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' }
   * // Forward traversal from task1: queries {collection}/task1/workflow
   * ```
   */
  targetGraph?: string;

  /**
   * Schema version for this type's data payload.
   * **Computed automatically** from `migrations` as `max(toVersion)`.
   * Do not set directly — provide migrations instead.
   */
  schemaVersion?: number;

  /**
   * Ordered list of migrations to transform data from older versions
   * to the current version. The schema version is derived as the highest
   * `toVersion` in this array.
   */
  migrations?: MigrationStep[];

  /**
   * Per-entry write-back override for auto-migrated records.
   * Takes precedence over `GraphClientOptions.migrationWriteBack`.
   * Omit to inherit the global setting.
   */
  migrationWriteBack?: MigrationWriteBack;
}

// ---------------------------------------------------------------------------
// Entity Discovery Types
// ---------------------------------------------------------------------------

/** Topology declaration for an edge (from edge.json). */
export interface EdgeTopology {
  from: string | string[];
  to: string | string[];
  inverseLabel?: string;
  /**
   * Subgraph name where cross-graph edges of this type live.
   * See `RegistryEntry.targetGraph` for full documentation.
   */
  targetGraph?: string;
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
  /** Data field to use as the display title (e.g. 'name', 'date'). */
  titleField?: string;
  /** Data field to use as the display subtitle (e.g. 'status', 'difficulty'). */
  subtitleField?: string;
  /** View defaults from meta.json. */
  viewDefaults?: ViewResolverConfig;
  /** Absolute path to views.ts if present. */
  viewsPath?: string;
  /** Sample data from sample.json. */
  sampleData?: Record<string, unknown>;
  /** Scope patterns constraining where this type can exist in subgraphs. */
  allowedIn?: string[];
  /** Subgraph name where cross-graph edges of this type live. */
  targetGraph?: string;
  /** Migration steps loaded from migrations.ts. */
  migrations?: MigrationStep[];
  /** Per-entity write-back override from meta.json. */
  migrationWriteBack?: MigrationWriteBack;
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

/** Options for defineNodeType / defineEdgeType beyond the core fields. */
export interface DefineTypeOptions {
  /** Data field to use as the display title (e.g. 'name', 'date'). */
  titleField?: string;
  /** Data field to use as the display subtitle (e.g. 'status', 'difficulty'). */
  subtitleField?: string;
  /** Mustache HTML template for rendering this type in the editor. */
  viewTemplate?: string;
  /** Scoped CSS for the view template (injected via Shadow DOM). */
  viewCss?: string;
  /** Scope patterns constraining where this type can exist in subgraphs. */
  allowedIn?: string[];
  /**
   * Migration steps. Accepts function objects (auto-serialized via .toString())
   * or strings (stored as-is). The schema version is derived as the highest
   * `toVersion` in this array.
   */
  migrations?: Array<{ fromVersion: number; toVersion: number; up: MigrationFn | string }>;
  /** Per-type write-back override for auto-migrated records. */
  migrationWriteBack?: MigrationWriteBack;
}

/** Data shape stored in a `nodeType` meta-node. */
export interface NodeTypeData {
  name: string;
  jsonSchema: object;
  description?: string;
  titleField?: string;
  subtitleField?: string;
  viewTemplate?: string;
  viewCss?: string;
  allowedIn?: string[];
  migrations?: StoredMigrationStep[];
  migrationWriteBack?: MigrationWriteBack;
}

/** Data shape stored in an `edgeType` meta-node. */
export interface EdgeTypeData {
  name: string;
  from: string | string[];
  to: string | string[];
  jsonSchema?: object;
  inverseLabel?: string;
  description?: string;
  titleField?: string;
  subtitleField?: string;
  viewTemplate?: string;
  viewCss?: string;
  allowedIn?: string[];
  targetGraph?: string;
  migrations?: StoredMigrationStep[];
  migrationWriteBack?: MigrationWriteBack;
}

export type ScanProtection = 'error' | 'warn' | 'off';

export interface GraphClientOptions {
  /**
   * Static registry built from code/discovery.
   *
   * When provided alone, all writes are validated against this registry.
   *
   * When provided together with `registryMode`, operates in **merged mode**:
   * static entries take priority and cannot be overridden by dynamic
   * definitions. Dynamic definitions can only add new types. The merged
   * client is returned as a `DynamicGraphClient`.
   */
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
  /**
   * Controls query safety behavior for full collection scan prevention.
   *
   * - `'error'` (default) — Throws `QuerySafetyError` for queries that would
   *   likely cause a full collection scan. Override per-query with
   *   `allowCollectionScan: true`.
   * - `'warn'` — Logs a warning but executes the query.
   * - `'off'` — No scan protection.
   */
  scanProtection?: ScanProtection;
  /**
   * Global default for write-back of auto-migrated records on read.
   *
   * - `'off'` (default) — Migrated data is returned but NOT written back.
   * - `'eager'` — Migrated data is written back immediately after migration.
   * - `'background'` — Write-back happens asynchronously; errors are logged.
   *
   * Per-entry `migrationWriteBack` on `RegistryEntry` overrides this setting.
   */
  migrationWriteBack?: MigrationWriteBack;
  /**
   * Custom executor for compiling dynamic registry migration source strings.
   * Defaults to SES Compartments with JSON marshaling. Supply an
   * alternative for custom sandboxing.
   *
   * Only used for dynamic registry migrations — static registry migrations
   * are already in-memory functions and never go through this executor.
   */
  migrationSandbox?: MigrationExecutor;
}

export interface GraphRegistry {
  validate(aType: string, axbType: string, bType: string, data: unknown, scopePath?: string): void;
  lookup(aType: string, axbType: string, bType: string): RegistryEntry | undefined;
  /** Return all entries matching the given axbType (edge relation name). */
  lookupByAxbType(axbType: string): ReadonlyArray<RegistryEntry>;
  /**
   * Return every edge entry originating from `aType` that has `targetGraph`
   * set — i.e. the direct subgraph children of nodes of this type.
   *
   * Used by backends that need to enumerate a node's subgraph DOs without
   * walking the graph. Each returned entry carries both `axbType` (the edge
   * label that introduces the subgraph) and `targetGraph` (the subgraph
   * segment name).
   *
   * Entries are deduplicated by `targetGraph` alone — the physical subgraph
   * store is addressed by `(parentUid, targetGraph)`, so multiple edge
   * relations (distinct `axbType` or `bType`) pointing into the same segment
   * collapse to a single representative entry. The first-declared entry
   * wins the collision. Callers only care about the subgraph name, not the
   * originating relation or target node type.
   */
  getSubgraphTopology(aType: string): ReadonlyArray<RegistryEntry>;
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
  /**
   * Create a scoped client for a Firestore subcollection under the given
   * parent node's document.
   *
   * The returned client shares a snapshot of the parent's registry at
   * the time of this call. If the parent is a `DynamicGraphClient` and
   * `reloadRegistry()` is called later, existing subgraph clients will
   * NOT see the updated types — create a new subgraph client after
   * reloading to pick up changes.
   *
   * @param parentNodeUid - UID of the parent node whose document owns the subcollection
   * @param name - Subcollection name (defaults to `'graph'`). Must not contain `/`.
   * @returns A `GraphClient` scoped to `{collectionPath}/{parentNodeUid}/{name}`
   */
  subgraph(parentNodeUid: string, name?: string): GraphClient;

  /**
   * Find edges across all subgraphs using a Firestore collection group query.
   *
   * Queries all collections with the given name (defaults to `'graph'`) across
   * the entire database. This is useful for cross-cutting reads that span
   * multiple subgraphs.
   *
   * **Requires** a Firestore collection group index for the query pattern.
   *
   * @param params - Edge filter parameters (same as `findEdges`)
   * @param collectionName - Collection name to query across (defaults to last segment of this client's collection path)
   */
  findEdgesGlobal(params: FindEdgesParams, collectionName?: string): Promise<StoredGraphRecord[]>;
}

export interface DynamicGraphClient extends GraphClient {
  /** Define or update a node type in the dynamic registry. */
  defineNodeType(
    name: string,
    jsonSchema: object,
    description?: string,
    options?: DefineTypeOptions,
  ): Promise<void>;

  /** Define or update an edge type in the dynamic registry. */
  defineEdgeType(
    name: string,
    topology: EdgeTopology,
    jsonSchema?: object,
    description?: string,
    options?: DefineTypeOptions,
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
  /**
   * Subgraph name to cross into for this hop (forward traversal only).
   *
   * When set, the traversal queries the named subgraph under each source node
   * instead of the current collection (`{collection}/{sourceUid}/{targetGraph}`).
   *
   * If omitted but the registry has a `targetGraph` for this `axbType`,
   * the registry value is used automatically.
   *
   * **Context tracking:** Once a hop crosses into a subgraph, subsequent
   * hops without `targetGraph` stay in that subgraph automatically. To
   * cross into a different subgraph, set `targetGraph` explicitly on the
   * next hop — explicit `targetGraph` always resolves relative to the
   * root client, not the current subgraph. To return to the root graph,
   * create a separate traversal from the root client.
   */
  targetGraph?: string;
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
  /**
   * Recursively delete subcollections (subgraphs) under the node's document.
   * Defaults to `true` for `removeNodeCascade`.
   */
  deleteSubcollections?: boolean;
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
