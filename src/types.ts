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
// Backend Capabilities
// ---------------------------------------------------------------------------

/**
 * Closed string-literal union of every logical capability a storage backend
 * may declare. Capabilities express user-facing query features, not SDK
 * details — the same logical capability may map to different SDK calls per
 * backend (e.g. `query.aggregate` is `runAggregationQuery` on Firestore
 * Standard, `pipeline().aggregate()` on Firestore Enterprise, `GROUP BY` on
 * SQL).
 *
 * See `.claude/backend-capabilities.md` for the design rationale and the
 * capability matrix per backend.
 */
export type Capability =
  // Core read/write — every backend declares these
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  // Logical query capabilities (may map to different SDK calls per backend)
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  // Edition-specific extensions (Firestore Enterprise only today)
  | 'search.fullText'
  | 'search.geo'
  | 'search.vector'
  // Realtime
  | 'realtime.listen'
  // Escape hatches
  | 'raw.firestore'
  | 'raw.sql';

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

// ---------------------------------------------------------------------------
// Secondary Index Types
// ---------------------------------------------------------------------------

/**
 * One field in a composite index. The string shorthand form defaults to
 * ascending order; use the object form when a field needs to be indexed
 * descending (e.g., pagination by `{ path: 'updatedAt', desc: true }`).
 */
export interface IndexFieldSpec {
  /**
   * Field path. Top-level firegraph fields (`aType`, `aUid`, `axbType`,
   * `bType`, `bUid`, `createdAt`, `updatedAt`, `v`) resolve to their
   * underlying columns. Dotted paths like `'data.status'` or
   * `'data.author.name'` index into the JSON data payload.
   *
   * Each dotted component must match `/^[A-Za-z_][A-Za-z0-9_-]*$/` — keys
   * with dots, quotes, brackets, spaces, or other syntax characters are
   * rejected at DDL build time. Indexes on exotic keys are not supported
   * because SQLite expression indexes must match the query compiler's
   * output verbatim, and inlining quoted path components into DDL would
   * desynchronize the two compilers. If you need to filter by an exotic
   * key, use `replaceNode` / `replaceEdge` writes rather than an indexed
   * field.
   */
  path: string;
  /** Descending order; defaults to ascending. */
  desc?: boolean;
}

/**
 * Declarative secondary index. Translators emit a `CREATE INDEX` statement
 * (SQLite) or a `FirestoreIndex` composite (Firestore) per spec.
 *
 * Composite indexes support the prefix of their `fields` list — a spec
 * `{ fields: ['aType', 'axbType'] }` also covers queries filtering on
 * `aType` alone.
 *
 * @example
 * ```ts
 * // Plain composite on top-level fields
 * { fields: ['aType', 'axbType'] }
 *
 * // Mixed string + object form; `updatedAt` descending
 * { fields: ['aType', 'aUid', 'axbType', { path: 'updatedAt', desc: true }] }
 *
 * // JSON data-field index (SQLite: expression index on json_extract)
 * { fields: ['aType', 'axbType', 'data.status'] }
 *
 * // Partial index (SQLite only — Firestore ignores the `where` clause)
 * { fields: ['aType'], where: "json_extract(data, '$.archived') = 0" }
 * ```
 */
export interface IndexSpec {
  /**
   * Ordered field list. String shorthand = ascending. Use `IndexFieldSpec`
   * form to mark individual fields descending.
   */
  fields: Array<string | IndexFieldSpec>;
  /**
   * Partial-index predicate. Applied verbatim after `WHERE` in the emitted
   * SQLite DDL. Ignored (with a one-time warning) by the Firestore
   * generator — Firestore composite indexes do not support predicates.
   */
  where?: string;
}

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

  /**
   * Secondary indexes tied to this triple. Each spec becomes a single
   * backend-native composite index scoped to rows matching
   * `(aType, axbType, bType)` — though the DDL does not currently restrict
   * by triple, so authors should think of these as globally-applied indexes
   * declared on the triple's behalf.
   *
   * Use this to accelerate `findNodes` / `findEdges` queries that filter
   * on `data.*` fields or compose with firegraph's top-level fields in ways
   * the default preset doesn't cover.
   */
  indexes?: IndexSpec[];
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
  /** Secondary indexes loaded from meta.json (`indexes` field). */
  indexes?: IndexSpec[];
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
  /**
   * Write a node, deep-merging into any existing record.
   *
   * Nested objects are merged recursively — sibling keys at any depth
   * survive. Arrays are terminal (replaced as a unit, not element-merged).
   * `undefined` values are omitted; `null` is preserved. To delete a field,
   * pass the `deleteField()` sentinel as its value.
   *
   * Use {@link replaceNode} when you want full-document replacement.
   */
  putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Write an edge, deep-merging into any existing record. See
   * {@link putNode} for the merge contract.
   */
  putEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Replace a node's `data` payload entirely. Any field absent from
   * `data` is dropped. Use sparingly — prefer {@link putNode} unless you
   * specifically need to drop unknown fields.
   */
  replaceNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Replace an edge's `data` payload entirely. See {@link replaceNode}.
   */
  replaceEdge(
    aType: string,
    aUid: string,
    axbType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  /**
   * Patch a node's `data` payload. Like {@link putNode} this is a deep
   * merge — nested objects are walked, only leaves are written. Use the
   * `deleteField()` sentinel to remove a field.
   */
  updateNode(uid: string, data: Record<string, unknown>): Promise<void>;
  /**
   * Patch an edge's `data` payload. See {@link updateNode}.
   */
  updateEdge(
    aUid: string,
    axbType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  removeNode(uid: string): Promise<void>;
  removeEdge(aUid: string, axbType: string, bUid: string): Promise<void>;
}

/**
 * Portable graph client surface.
 *
 * Every backend supports these methods unconditionally — they are the
 * "graph as a graph" operations: read/write nodes and edges, run
 * transactions, scope into subgraphs, etc. Edition-specific extensions
 * (aggregate, full-text search, vector search, raw escape hatches, etc.)
 * are added by intersection in `GraphClient<C>` only when the backend
 * declares the matching capability — see the `*Extension` interfaces and
 * `GraphClient<C>` below.
 */
export interface CoreGraphClient extends GraphReader, GraphWriter {
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

// ---------------------------------------------------------------------------
// Capability Extensions
// ---------------------------------------------------------------------------
//
// Each `*Extension` interface bundles one logical capability's surface.
// Phase 3 declares the *types* — runtime methods on `GraphClientImpl` land
// in Phases 4–10 alongside the matching backend implementations. Until then
// the extension methods are unreachable in practice because no backend
// declares the relevant capability (see `BackendCapabilities` in each
// backend's `*BackendImpl` constructor). The conservative invariant
// preserves the contract: a declared capability is always backed by a real
// method.

/** Supported aggregation operations.
 *
 * Firestore Standard supports `count`, `sum`, `avg` only. SQLite/DO additionally
 * support `min` and `max` via SQL. Backends that cannot satisfy a requested op
 * throw `FiregraphError` with code `UNSUPPORTED_AGGREGATE`.
 */
export type AggregateOp = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** A single aggregation request.
 *
 * `field` is required for `sum`/`avg`/`min`/`max` and follows the same dotted
 * path convention as `QueryFilter.field` (e.g. `'data.price'`). For `count`
 * the field is forbidden — every backend rejects `count` with a stray field
 * via `INVALID_QUERY`. We reject (rather than silently ignore) so a typo like
 * `{ n: { op: 'count', field: 'data.price' } }` — easy to introduce when
 * cribbing a sum spec and changing only the op — surfaces as a clear error
 * instead of producing misleading row counts. */
export interface AggregateField {
  op: AggregateOp;
  field?: string;
}

/** Map of result alias -> aggregation request. */
export type AggregateSpec = Record<string, AggregateField>;

/** Result shape derived from an `AggregateSpec` — one number per alias. */
export type AggregateResult<A extends AggregateSpec> = {
  [K in keyof A]: number;
};

/** Aggregate query surface — count/sum/avg/min/max over a filter set. */
export interface AggregateExtension {
  aggregate<A extends AggregateSpec>(
    params: FindEdgesParams & { aggregates: A },
  ): Promise<AggregateResult<A>>;
}

/** Server-side projection — return only the requested data fields. */
export interface SelectExtension {
  // Methods land in Phase 7.
}

/** Multi-hop fan-out with target-node hydration in one round trip. */
export interface JoinExtension {
  // Methods land in Phase 6.
}

/**
 * Patch shape for `bulkUpdate`.
 *
 *   - `data`: a deep partial of the row's `data` field. Applied via
 *     deep-merge semantics (the same `flattenPatch` pipeline that
 *     `updateNode` / `updateEdge` use). Use `deleteField()` sentinels to
 *     remove individual leaves; arrays are replaced as a unit, never
 *     concatenated.
 *
 * Backends with `query.dml` translate this to a single server-side UPDATE
 * statement. The patch is applied to every row that matches the filter
 * list; there is no per-row callback or read-modify-write loop. Identifying
 * fields (`aType`, `axbType`, `bType`, `aUid`, `bUid`, `v`) are owned by
 * firegraph and cannot be mutated through `bulkUpdate` — pass them in the
 * filter list to scope the update, not in the patch body.
 */
export interface BulkUpdatePatch {
  /** Deep-partial patch applied to each matching row's `data` field. */
  data: Record<string, unknown>;
}

/** Server-side conditional bulk DML — bulkDelete / bulkUpdate.
 *
 * Backends declaring `query.dml` translate each call to one server-side
 * statement (Firestore Pipeline `remove`/`update` stage, SQL `DELETE`/
 * `UPDATE`). Standard Firestore omits this capability and the
 * Phase 5 code falls back to the existing fetch-then-write loop in
 * `src/bulk.ts`.
 *
 * Both methods scope to the **current backend** only — they do not fan
 * out to routed children or subcollections. Use `removeNodeCascade` for
 * the cascade-aware cousin of `bulkDelete`. */
export interface DmlExtension {
  /**
   * Delete every row matching `params` in one server-side statement.
   * Subject to the same scan-protection rules as `findEdges`: pass
   * `allowCollectionScan: true` to bypass.
   */
  bulkDelete(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult>;
  /**
   * Update every row matching `params` with `patch` in one server-side
   * statement. The patch is deep-merged into each row's `data` field.
   * Identifying columns (`aType`, `axbType`, etc.) are immutable through
   * this path — to relabel rows, delete and re-insert.
   */
  bulkUpdate(
    params: FindEdgesParams,
    patch: BulkUpdatePatch,
    options?: BulkOptions,
  ): Promise<BulkResult>;
}

/** Native full-text search. */
export interface FullTextSearchExtension {
  // Methods land in Phase 9.
}

/** Native geospatial distance search. */
export interface GeoExtension {
  // Methods land in Phase 10.
}

/** Native vector / nearest-neighbour search. */
export interface VectorExtension {
  // Methods land in Phase 8.
}

/** Escape hatch — expose the underlying Firestore handle. */
export interface RawFirestoreExtension {
  // Property surface lands in a later phase. The interface exists today so
  // that `GraphClient<'raw.firestore' | …>` is a distinct type from
  // `GraphClient<…>` without `'raw.firestore'`, even before any property
  // is declared.
}

/** Escape hatch — expose the underlying SQL executor. */
export interface RawSqlExtension {
  // Property surface lands in a later phase.
}

/** Realtime listener API — `onSnapshot`-style live subscriptions. */
export interface RealtimeListenExtension {
  // Method surface lands in a later phase. The interface exists today so the
  // conditional intersection in `GraphClient<C>` is symmetric with every
  // other capability slot — `realtime.listen` is part of the closed
  // `Capability` union, so it must have a matching extension placeholder.
}

/**
 * Capability-gated graph client.
 *
 * `C` is the closed union of capabilities the underlying backend
 * declared. Each extension is conditionally intersected: it appears in the
 * resulting type only when the matching capability is in `C`. The default
 * `C = Capability` evaluates every conditional truthy, yielding the full
 * surface — that is the "permissive" shape returned when no capability
 * narrowing is in effect (e.g. legacy callers using
 * `let x: GraphClient = …` without a parameter).
 *
 * Why distributive conditionals work: `'query.aggregate' extends C ? A : B`
 * distributes over the union members of `C`. If any union member is
 * `'query.aggregate'`, the conditional evaluates to `A`; otherwise `B`.
 * Intersection with `object` (the false branch) is a no-op, so omitted
 * extensions contribute nothing to the resulting type.
 */
export type GraphClient<C extends Capability = Capability> = CoreGraphClient &
  ('query.aggregate' extends C ? AggregateExtension : object) &
  ('query.select' extends C ? SelectExtension : object) &
  ('query.join' extends C ? JoinExtension : object) &
  ('query.dml' extends C ? DmlExtension : object) &
  ('search.fullText' extends C ? FullTextSearchExtension : object) &
  ('search.geo' extends C ? GeoExtension : object) &
  ('search.vector' extends C ? VectorExtension : object) &
  ('realtime.listen' extends C ? RealtimeListenExtension : object) &
  ('raw.firestore' extends C ? RawFirestoreExtension : object) &
  ('raw.sql' extends C ? RawSqlExtension : object);

/**
 * Methods present only on dynamic-registry clients. Composed with
 * `GraphClient<C>` to form `DynamicGraphClient<C>` — the type returned
 * by `createGraphClient(...)` when `registryMode` is set on the options.
 */
export interface DynamicGraphMethods {
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

/**
 * Dynamic-registry graph client. Same conditional capability surface as
 * `GraphClient<C>`, plus the meta-type definition methods.
 */
export type DynamicGraphClient<C extends Capability = Capability> = GraphClient<C> &
  DynamicGraphMethods;

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
