import type { FieldValue, Timestamp, WhereFilterOp } from '@google-cloud/firestore';

import type { ViewResolverConfig } from './config.js';
import type { BackendCapabilities } from './internal/backend.js';
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
  /**
   * Capability set of the underlying storage backend. Mirrors
   * `StorageBackend.capabilities` so callers can do portability checks
   * without reaching for the backend handle:
   *
   * ```ts
   * if (client.capabilities.has('query.join')) {
   *   await client.expand({ sources, axbType: 'wrote' });
   * } else {
   *   // fall back to the per-source loop in createTraversal()
   * }
   * ```
   *
   * The set is static for the lifetime of the client (invariant 3 from
   * `.claude/backend-capabilities.md`). Subgraph clients return the cap
   * set of their wrapped backend — typically identical to the parent's,
   * but the routing wrapper may return a narrowed set when crossing into
   * a routed child of a different backend type.
   */
  readonly capabilities: BackendCapabilities;
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

/**
 * One row in the result of a `findEdgesProjected()` call.
 *
 * The shape is `{ [F]: unknown }` over the caller-supplied field list `F`.
 * Each value is whatever the backend extracted from the underlying record:
 *
 *   - Top-level firegraph fields (`aType`, `aUid`, `axbType`, `bType`,
 *     `bUid`, `createdAt`, `updatedAt`, `v`) come back as the same JS shape
 *     `findEdges` produces — strings for the identifying fields, `number |
 *     null` for `v` (`null` when the record predates schema versioning),
 *     and the backend's native timestamp instance (Firestore's `Timestamp`
 *     or `GraphTimestampImpl`) for `createdAt` / `updatedAt`.
 *   - A bare name (e.g. `'title'`) is interpreted as `data.<name>`. SQL
 *     backends extract via `json_extract` and the value comes back as the
 *     JSON-decoded primitive / object. Firestore returns the field's stored
 *     type unchanged.
 *   - A dotted `data.x.y` path is the explicit form for nested fields.
 *   - Absent paths surface as `null` (not `undefined`) across all backends
 *     so that `JSON.stringify(row)` round-trips the requested shape.
 *
 * Why `unknown` rather than a stricter type: per-entity codegen integration
 * (Phase 7 plan note) is the right place to surface concrete value types.
 * Until that lands, the projection layer doesn't know whether `data.title`
 * is a string, a number, or an object — a stricter type would lie. Use
 * a registry-aware wrapper (or a per-call cast) to narrow.
 */
export type ProjectedRow<F extends ReadonlyArray<string>> = {
  [K in F[number]]: unknown;
};

/**
 * Parameters for `findEdgesProjected` — `FindEdgesParams` plus a `select`
 * field list. Field names follow the same rules as `WhereClause.field`:
 *
 *   - Built-in record fields (`aType`, `aUid`, etc.) resolve to their typed
 *     column / Firestore field directly.
 *   - A bare name resolves to `data.<name>` (the most common shape — most
 *     callers project a few keys out of the JSON payload).
 *   - A dotted `data.x.y` path is explicit.
 *
 * Empty `select: []` is rejected at the client level. The backend never
 * sees an empty projection list because `SELECT FROM …` (no projection
 * clause) is a syntactically different query and `SELECT * FROM …` is what
 * `findEdges` already does.
 *
 * Duplicate entries in `select` are collapsed at compile time — the
 * resulting row carries one slot per unique field. This keeps the
 * SQL projection list minimal and matches Firestore's `Query.select(...)`
 * de-duplication behaviour.
 */
export interface FindEdgesProjectedParams<F extends ReadonlyArray<string>> extends FindEdgesParams {
  /** Non-empty list of field paths to return. See type-level docs for the
   * dotted-path convention. */
  select: F;
}

/**
 * Server-side field projection — return only the requested fields.
 *
 * Backends declaring `query.select` translate the call into a projecting
 * server-side query (`SELECT json_extract(data, '$.f1'), …` on SQLite,
 * `Query.select(...)` on Firestore Standard, pipeline `select()` on
 * Firestore Enterprise). Backends without the cap throw
 * `UNSUPPORTED_OPERATION` from the client wrapper — there is no
 * client-side fallback that materialises full rows and then drops fields,
 * because the wire-payload reduction is the entire point of the API.
 */
export interface SelectExtension {
  /** Fetch only the requested field paths from each matching edge.
   *
   * Returns one `ProjectedRow<F>` per matching edge, in the same order
   * `findEdges` would have produced. Migrations are not applied — the
   * projection bypasses the read-path migration pipeline because the
   * caller asked for a specific shape, not a full record. If you need the
   * migrated shape, use `findEdges` and project in JS.
   */
  findEdgesProjected<F extends ReadonlyArray<string>>(
    params: FindEdgesProjectedParams<F>,
  ): Promise<Array<ProjectedRow<F>>>;
}

/**
 * Parameters for one expansion hop — fan out from a set of source UIDs over
 * a single edge type in one server-side round trip.
 *
 * The shape mirrors `HopDefinition` (see `traverse.ts`) but is flat instead
 * of chained: a multi-hop traversal calls `expand()` once per depth, and
 * the traversal layer drives the hop-to-hop loop. We keep `expand()` per-
 * depth (not per-traversal) for two reasons:
 *
 *   1. **Backend symmetry.** SQL `JOIN`s and Firestore Pipeline subqueries
 *      both express N→1-source fan-out cleanly, but neither expresses
 *      arbitrary-depth chained joins as a single statement (CTEs are
 *      possible, but the `IN (?, …)` cap on Firestore makes a multi-depth
 *      pipeline brittle). Per-depth fan-out is the largest constant-factor
 *      win that's portable across all backends declaring `query.join`.
 *
 *   2. **Result shaping.** Per-hop edges feed cross-graph hops and
 *      `targetGraph` re-routing, which traversal already owns. Pushing the
 *      whole chain into one backend call would re-implement that logic at
 *      the storage layer.
 */
export interface ExpandParams {
  /** Source UIDs from which to expand. The hop matches every row whose
   * `aUid` (forward) or `bUid` (reverse) is in this list. May be empty —
   * empty input yields empty output without touching the backend. */
  sources: string[];
  /** Edge relation name. Required. */
  axbType: string;
  /** Hop direction. `'forward'` (default) follows `aUid → bUid`; `'reverse'`
   * follows `bUid → aUid`. */
  direction?: 'forward' | 'reverse';
  /** Optional `aType` predicate on the matched edge. */
  aType?: string;
  /** Optional `bType` predicate on the matched edge. */
  bType?: string;
  /** Per-source soft fan-out cap. The backend translates this to an upper
   * bound on the total result count (`sources.length * limitPerSource`); it
   * does **not** enforce strict per-source limits — a SQL `LIMIT N` over an
   * `IN (…)` query may return all N rows from a single source if that's
   * where the matches concentrate. Callers needing strict per-source caps
   * should fall back to the per-hop loop. */
  limitPerSource?: number;
  /** Order edges by field; applied before limit. */
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  /** Hydrate target nodes alongside edges. When `true`, the returned
   * `ExpandResult.targets` array is index-aligned with `edges` and contains
   * the corresponding target-side node record (the b-side for forward, the
   * a-side for reverse) or `null` when the node row is missing. */
  hydrate?: boolean;
}

/** Result shape for one `expand()` call.
 *
 * `edges` is the list of edge rows that matched the hop, in the order the
 * backend returned them (subject to `orderBy`). `targets`, when present,
 * is the same length as `edges` — one slot per edge — and holds the
 * corresponding target-side node record (or `null` when the target node
 * does not exist). */
export interface ExpandResult {
  edges: StoredGraphRecord[];
  /** Present iff the request set `hydrate: true`. Index-aligned with
   * `edges`; entries are `null` for edges whose target node row is
   * missing. */
  targets?: Array<StoredGraphRecord | null>;
}

/** Multi-hop fan-out with target-node hydration in one round trip per hop.
 *
 * Backends declaring `query.join` translate one `expand()` call into one
 * server-side query (SQL `IN (…)`, Firestore Pipeline batched fan-out).
 * That collapses the per-source `findEdges` loop in `traverse.ts` into a
 * single round trip per hop, regardless of source-set size.
 *
 * Backends without `query.join` are not required to expose `expand()` at
 * all — `traverse.ts` keeps the per-source loop for them. The capability
 * gate is the single source of truth on whether the optimization runs. */
export interface JoinExtension {
  /** Fan out from `params.sources` over `params.axbType` in one round
   * trip. See `ExpandParams` for shape and `ExpandResult` for return value.
   *
   * Cross-graph hops (those with `targetGraph`) are not eligible for
   * `expand()` because each source UID would resolve to a distinct
   * subgraph location — there's no single collection to fan out over.
   * Callers (notably `traverse.ts`) detect cross-graph hops and stay on
   * the per-source loop. */
  expand(params: ExpandParams): Promise<ExpandResult>;
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

/**
 * Parameters for a server-side full-text search query (deferred — see
 * `FullTextSearchExtension` for the SDK-gap rationale).
 *
 * Recorded here so the API contract is committed to the type surface; once
 * a backend declares `'search.fullText'` and implements the runtime path,
 * this becomes the input to `FullTextSearchExtension.search`. Field-path
 * conventions match `FindNearestParams.vectorField` and `WhereClause.field`
 * — bare names resolve to `data.<name>`, envelope fields are rejected.
 */
export interface FullTextSearchParams {
  /**
   * Optional filter on `aType`. The implementation is expected to scope
   * the search to the per-type indexed collection rather than emitting a
   * follow-up `where(aType==…)`, because the underlying Firestore Pipeline
   * `search()` stage must be the first stage.
   */
  aType?: string;
  /** Free-form query string. The search index tokenises and ranks. */
  query: string;
  /**
   * Indexed text fields to search across. Bare names resolve to
   * `data.<name>` per the same convention as `select` / `where`. If
   * omitted, the search index's default field set is used.
   */
  fields?: string[];
  /** Upper bound on rows returned, sorted by relevance. */
  limit: number;
}

/**
 * Native full-text search.
 *
 * **Status: deferred on Firestore Enterprise; not applicable elsewhere.**
 *
 *   - **Firestore Standard** does not support full-text search at all —
 *     it is an Enterprise-only product feature. This row will never
 *     become "✓".
 *   - **Firestore Enterprise** supports FTS in production, but
 *     `@google-cloud/firestore@8.3.0` does not expose a typed
 *     `Pipeline.search(...)` method. The released `Pipeline` surface is
 *     `addFields`, `aggregate`, `distinct`, `execute`, `findNearest`,
 *     `limit`, `offset`, `rawStage`, `removeFields`, `replaceWith`,
 *     `sample`, `select`, `sort`, `stream`, `union`, `unnest`, `where`.
 *     Reaching FTS today requires the `rawStage(...)` escape hatch
 *     against a real Enterprise database — a typed-API gap, not a
 *     feature gap. We have not declared `'search.fullText'` because
 *     doing so without a runtime path would break the routing
 *     invariant ("declared capability ⇒ method exists").
 *   - **SQLite / Cloudflare DO** have no native FTS index. Emulating
 *     it over `json_extract` is not viable; the row will never become
 *     "✓" on these editions.
 *
 * The interface and `FullTextSearchParams` exist so the contract is
 * recorded on the type surface and so wiring is additive when the SDK
 * exposes a typed stage or when we commit to a `rawStage('search', { … })`
 * implementation gated behind `FIREGRAPH_ENTERPRISE=1`.
 */
export interface FullTextSearchExtension {
  // No runtime methods — see the JSDoc above for the typed-API-gap rationale.
}

/**
 * Geographic point — lat/lng in degrees. Mirrors the runtime shape of
 * Firestore's `GeoPoint` so callers can pass either a literal or a
 * `GeoPoint` instance once wiring lands.
 */
export interface GeoPointLiteral {
  lat: number;
  lng: number;
}

/**
 * Parameters for a server-side geospatial distance query (deferred — see
 * `GeoExtension` for the SDK-gap rationale).
 */
export interface GeoSearchParams {
  /** Optional filter on `aType` — narrows the per-type collection scope. */
  aType?: string;
  /**
   * Field path of the indexed `GeoPoint`. Bare name → `data.<name>` per
   * the same convention as `select` / `where`. Built-in envelope fields
   * are rejected.
   */
  geoField: string;
  /** Centre of the search radius. */
  point: GeoPointLiteral;
  /** Search radius in metres. */
  radiusMeters: number;
  /** Upper bound on rows returned. */
  limit: number;
  /**
   * If true (default), results are sorted nearest-first; if false,
   * ordering is unspecified — the backend may return rows in whatever
   * order the geo index emits.
   */
  orderByDistance?: boolean;
}

/**
 * Native geospatial distance search.
 *
 * **Status: deferred on Firestore Enterprise; not applicable elsewhere.**
 *
 *   - **Firestore Standard** does not support geospatial queries at all
 *     — it is an Enterprise-only product feature. This row will never
 *     become "✓".
 *   - **Firestore Enterprise** supports geo queries in production, but
 *     `@google-cloud/firestore@8.3.0` does not expose a typed
 *     geo-distance pipeline stage. The released `Pipeline` surface is
 *     listed in `FullTextSearchExtension`'s JSDoc; reaching geo today
 *     requires `rawStage(...)` against a real Enterprise database — a
 *     typed-API gap, not a feature gap.
 *   - **SQLite / Cloudflare DO** have no native geo index, so the row
 *     will never become "✓" on these editions either.
 *
 * The interface, `GeoSearchParams`, and `GeoPointLiteral` are recorded
 * so the API contract exists on the type surface; wiring is additive
 * when the SDK exposes a typed stage or we commit to a `rawStage(...)`
 * implementation gated behind `FIREGRAPH_ENTERPRISE=1`.
 */
export interface GeoExtension {
  // No runtime methods — see the JSDoc above for the typed-API-gap rationale.
}

/**
 * Distance metric for vector / nearest-neighbour search. Mirrors
 * Firestore's `VectorQueryOptions.distanceMeasure` enum so the value
 * passes through to the SDK without translation:
 *
 *   - `EUCLIDEAN` — straight-line distance in n-dimensional space; lower
 *     is more similar.
 *   - `COSINE` — angle between vectors; lower is more similar (1 −
 *     cosine_similarity).
 *   - `DOT_PRODUCT` — inner product; *higher* is more similar. The
 *     `distanceThreshold` semantics flip accordingly (see
 *     `FindNearestParams`).
 */
export type DistanceMeasure = 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';

/**
 * Parameters for a server-side vector / nearest-neighbour query.
 *
 * Identifying filters (`aType`, `axbType`, `bType`) and `where` clauses
 * narrow the candidate set *before* the ANN query runs — Firestore folds
 * them into the same `Query` the vector index walks. Combining multiple
 * filters with vector search requires composite indexes on Firestore
 * Standard; the Enterprise edition lifts the index requirement for some
 * shapes (see Firestore docs).
 *
 * `vectorField` follows the same dotted-path / bare-name convention as
 * `select` in `FindEdgesProjectedParams` and `field` in `WhereClause`:
 *
 *   - A bare name (e.g. `'embedding'`) resolves to `data.embedding`.
 *   - A literal `'data'` or `'data.<x>'` is taken as-is.
 *   - Built-in envelope fields are not vector-indexable — passing one
 *     throws `INVALID_QUERY` at the client surface.
 *
 * `queryVector` accepts either a plain `number[]` or a Firestore
 * `VectorValue`. The dimension must match the indexed `vectorField`'s
 * dimension; Firestore filters out rows whose vector dimension differs
 * (rather than throwing) so the result set may be smaller than `limit`.
 *
 * `distanceThreshold` semantics depend on `distanceMeasure`:
 *
 *   - `EUCLIDEAN` / `COSINE` → return rows with `distance <=` threshold.
 *   - `DOT_PRODUCT` → return rows with `distance >=` threshold (higher
 *     dot product = more similar).
 *
 * If `distanceResultField` is set, every returned record carries the
 * computed distance at that field path inside `data`. Pass a built-in
 * envelope field name (e.g. `'aType'`) and the request fails server-side
 * — the SDK reserves the envelope.
 */
export interface FindNearestParams {
  /** Optional filter on `aType`. Resolves to `where('aType', '==', …)`. */
  aType?: string;
  /** Optional filter on `axbType`. */
  axbType?: string;
  /** Optional filter on `bType`. */
  bType?: string;
  /**
   * Field path of the indexed vector. Bare name → `data.<name>`. Built-in
   * envelope fields are rejected — they are not vector-indexable.
   */
  vectorField: string;
  /** Query vector. `number[]` or `VectorValue`; must match the indexed dimension. */
  queryVector: number[] | { toArray(): number[] };
  /** Upper bound on rows returned. Firestore caps at 1000. */
  limit: number;
  /** Distance metric — see `DistanceMeasure` for the semantics flip on `DOT_PRODUCT`. */
  distanceMeasure: DistanceMeasure;
  /**
   * Optional similarity cutoff. Interpretation depends on `distanceMeasure`
   * — see the type-level docs.
   */
  distanceThreshold?: number;
  /**
   * Optional dotted path that, if set, will be populated on each returned
   * record with the computed distance. Bare name → `data.<name>`. Use this
   * when downstream code needs to rank or threshold the results in JS.
   */
  distanceResultField?: string;
  /**
   * Additional filters applied before the ANN walk. Same shape as
   * `findEdges({ where })`. Field-path rules match `WhereClause.field`.
   */
  where?: WhereClause[];
  /**
   * Bypass scan-protection for unfiltered vector searches. A vector query
   * with no `aType` / `axbType` / `bType` / `where` filters scans every
   * row in the collection before the ANN narrowing — opt in explicitly.
   */
  allowCollectionScan?: boolean;
}

/**
 * Native vector / nearest-neighbour search.
 *
 * Backends declaring `search.vector` translate the call into a single
 * server-side `findNearest` query. The SQLite-shaped backends (shared
 * SQLite, Cloudflare DO) do not declare this capability — they have no
 * native vector index, and emulating ANN on top of `json_extract` is a
 * non-starter for any realistic dataset. Firestore Standard and
 * Enterprise both implement it via the classic `Query.findNearest(...)`
 * API; the pipeline `findNearest` stage is a future optimisation.
 *
 * Migrations are NOT applied to the result. The vector query selects
 * documents by similarity, not by query plan — applying migrations
 * inline would change the candidate set the index already walked. If
 * you need migrated shape, follow up with `getNode` / `findEdges` on the
 * returned UIDs.
 */
export interface VectorExtension {
  /**
   * Run a vector / nearest-neighbour search. Returns the top-K records
   * by similarity, sorted nearest-first (or furthest-first for
   * `DOT_PRODUCT` where higher = more similar).
   *
   * Throws:
   *
   *   - `INVALID_QUERY` if `vectorField` resolves to a built-in envelope
   *     field, `limit` is non-positive or > 1000, `queryVector` is
   *     empty, or `distanceResultField` collides with a built-in.
   *   - `QUERY_SAFETY` if no identifying filters / `where` clauses are
   *     supplied and `allowCollectionScan` is not set.
   *   - `UNSUPPORTED_OPERATION` if the backend does not declare
   *     `search.vector`.
   */
  findNearest(params: FindNearestParams): Promise<StoredGraphRecord[]>;
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
