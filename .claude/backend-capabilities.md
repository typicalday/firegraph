# Backend Capabilities & Edition Model

> **Status:** design reference. Companion to [`.claude/plans/backend-capabilities-plan.md`](plans/backend-capabilities-plan.md). Read both before implementing.

## 1. Why this exists

Firegraph today assumes one Firestore. In April 2026 that assumption broke. Firestore now ships in two editions with overlapping but **non-equivalent** query engines, served by the same `@google-cloud/firestore` SDK:

- **Firestore Standard edition** — the historical Firestore. Auto-creates single-field indexes, requires composite indexes for compound queries, supports the classic `Query` API and the classic aggregation API (`runAggregationQuery`: count/sum/avg). **Pipelines are not supported.** Pipeline calls against a Standard database fail with a server-side error.
- **Firestore Enterprise edition** — the new query engine. Indexes are optional. Exposes Firestore Pipelines (`db.pipeline()...`) including subqueries/joins, server-side DML, full-text search (preview), geospatial (preview), `findNearest` vector search, and `aggregate` stage. **Loses some primitives** the classic Query API has — most importantly, **`onSnapshot`/realtime listeners are not supported on pipeline queries**, and the Firebase emulator does not execute pipeline queries.

Plus the existing non-Firestore backends:

- **SQLite (shared)** — backs Cloudflare D1 and any host-side SQLite usage. SQL with full join, aggregate, and DML support.
- **Cloudflare DO SQLite** — per-DO storage, same SQL surface as shared SQLite.

Today firegraph's code path conflates "Firestore" with "Firestore + Pipelines." `queryMode: 'pipeline'` is the **default** for Firestore clients ([core-library.md](rules/core-library.md)). That default is silently wrong for any user pointing at a Standard database. We need to encode the edition split in the type system, not in runtime probes or documentation discipline.

## 2. Design principles

1. **Portability is encoded in imports, not runtime checks.** A user's portability assumption shows up at the import site (which subpath / which constructor they call). Capability gating happens at compile time via the type system.
2. **The portable core is honest.** `GraphReader` / `GraphWriter` only contain operations every backend implements faithfully. We never ship a "best effort" emulation that silently changes performance characteristics across backends.
3. **Capabilities are declared, not detected.** No runtime probing of "is this database Enterprise?" The user picks their backend explicitly.
4. **Strict typing over runtime errors.** `client.search(...)` against a Standard backend is a type error, not a 400 at runtime.
5. **The same logical capability can map to different SDK calls per backend.** Aggregations are a single capability; their implementation differs (pipeline `aggregate()` on Enterprise, `runAggregationQuery` on Standard, `GROUP BY` on SQL).
6. **One PR, big-bang refactor.** No backwards-compatibility shims. The library has a single consumer (the maintainer); breakages get fixed downstream.

## 3. Capability taxonomy

Capabilities are a closed string-literal union. Each capability is a single logical query feature, expressible in user-facing API terms — not an SDK detail.

```ts
// src/types.ts — public
export type Capability =
  // Core read/write — every backend declares these
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  // Logical query capabilities (may map to different SDK calls per backend)
  | 'query.aggregate' // count / sum / avg / min / max
  | 'query.select' // server-side field projection
  | 'query.join' // multi-collection / multi-hop fan-out in one round trip
  | 'query.dml' // server-side conditional update / delete
  // Edition-specific extensions (Firestore Enterprise only today)
  | 'search.fullText' // pipeline `search()` stage
  | 'search.geo' // pipeline geospatial stage
  | 'search.vector' // pipeline `findNearest`
  // Realtime
  | 'realtime.listen' // onSnapshot / SSE-style streams
  // Escape hatches
  | 'raw.firestore' // give me the underlying Firestore handle
  | 'raw.sql'; // give me a parameterized SQL executor
```

### Capability matrix (target state)

| Capability          | Firestore Standard                            | Firestore Enterprise                                                   | SQLite (shared)                 | Cloudflare DO               |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | --------------------------- |
| `core.read`         | ✓                                             | ✓                                                                      | ✓                               | ✓                           |
| `core.write`        | ✓                                             | ✓                                                                      | ✓                               | ✓                           |
| `core.transactions` | ✓                                             | ✓ (classic API; pipelines not transactional)                           | ✓                               | ✓                           |
| `core.batch`        | ✓                                             | ✓                                                                      | ✓                               | ✓                           |
| `core.subgraph`     | ✓                                             | ✓                                                                      | ✓                               | ✓                           |
| `query.aggregate`   | ✓ via `runAggregationQuery`                   | ✓ via pipeline `aggregate()`                                           | ✓ via SQL `GROUP BY`            | ✓ via SQL `GROUP BY`        |
| `query.select`      | ✓ via classic field mask                      | ✓ via pipeline `select()`                                              | ✓ via SQL projection            | ✓ via SQL projection        |
| `query.join`        | ✗                                             | ✓ via pipeline subqueries                                              | ✓ via SQL `JOIN`                | ✓ via SQL `JOIN`            |
| `query.dml`         | ✗                                             | ✓ via pipeline `update()`/`delete()`                                   | ✓ via SQL `UPDATE`/`DELETE`     | ✓ via SQL `UPDATE`/`DELETE` |
| `search.fullText`   | ✗                                             | ✓ (Preview)                                                            | ✗ (could add SQLite FTS5 later) | ✗                           |
| `search.geo`        | ✗                                             | ✓ (Preview)                                                            | ✗                               | ✗                           |
| `search.vector`     | ✓ classic vector index (faster for ANN today) | ✓ pipeline `findNearest` (slower until index types align)              | ✗                               | ✗                           |
| `realtime.listen`   | ✓                                             | ✓ for classic queries only — pipelines do **not** support `onSnapshot` | ✗                               | ✗                           |
| `raw.firestore`     | ✓                                             | ✓                                                                      | ✗                               | ✗                           |
| `raw.sql`           | ✗                                             | ✗                                                                      | ✓                               | ✓                           |

### Why these granularities

- `query.aggregate` is one capability even though Standard implements it via classic API and Enterprise implements it via pipelines. The user-facing API is the same; the backend's `query.aggregate` implementation chooses the right SDK call.
- `search.vector` is a single capability, but **Standard and Enterprise implement it differently** under the hood (classic vector index vs. pipeline `findNearest`). The portable user contract is "give me the K nearest vectors to a query embedding"; the implementation is private.
- `realtime.listen` is split out because Enterprise's pipeline path **loses** it. A user who wants realtime must use a backend (or backend mode) that declares this capability.
- The edition itself (`Standard` vs `Enterprise`) is **not** a capability. We never branch on edition; we branch on capabilities. This keeps the design open to future editions or hybrid modes.

## 4. The capability descriptor

Every backend declares its capabilities at construction. The descriptor is a typed `Set` so membership is checkable both at runtime and at the type level.

```ts
// src/internal/backend.ts

export interface BackendCapabilities<C extends Capability = Capability> {
  /** Set membership at runtime. */
  has(capability: C): boolean;
  /** Iterate for diagnostics. */
  values(): IterableIterator<C>;
  /** Type-level marker — never read at runtime. */
  readonly _phantom?: C;
}
```

The `_phantom` field is the trick that makes the type-level set actually constrain the type. We don't read it; it exists so TypeScript can narrow. (See §7.)

`StorageBackend` gains a single field:

```ts
export interface StorageBackend<C extends Capability = Capability> {
  readonly capabilities: BackendCapabilities<C>;
  // ...all existing fields unchanged
}
```

The default type parameter `C extends Capability = Capability` means existing call sites that don't care about capabilities get the widest type and behave as today. New planner / extension code parameterizes on a narrower `C`.

### Conventions for declaring capabilities

- Capabilities are declared **statically** at backend construction. They never change at runtime.
- Each backend module exports a `const CAPABILITIES = new Set<Capability>([...])` constant. The constructor closes over it.
- Capabilities should reflect what the backend **actually** implements correctly. If you can't ship the SQL `JOIN` for a multi-hop pipeline that meets the same observable contract as the Enterprise version, do not declare `query.join` on that backend. Add it later in a separate phase.

## 5. Backend packaging & entry points

### Subpath layout

```
firegraph                       (core, no vendor SDKs imported)
firegraph/firestore-standard    (Standard edition — classic Query API only)
firegraph/firestore-enterprise  (Enterprise edition — pipelines + extensions)
firegraph/sqlite                (shared SQLite backend; new dedicated entry)
firegraph/cloudflare            (DO backend — already exists)
firegraph/react                 (already exists)
firegraph/svelte                (already exists)
firegraph/backend               (already exists — public backend interface re-exports)
firegraph/query-client          (already exists)
```

**Rationale.** Both Firestore editions share the same npm package (`@google-cloud/firestore`), so the subpath split is **not** about bundle isolation. It is about:

1. **Capability declaration is forced at the import site.** A user who imports `firegraph/firestore-standard` cannot accidentally call pipeline-only APIs.
2. **Different defaults per edition.** Standard's backend never sets up a pipeline adapter. Enterprise's backend wires both classic and pipeline adapters and uses pipelines by default.
3. **Different extension types per edition.** The Enterprise entry point is the only place `client.search`, `client.findNearest`, etc. exist — they're not even reachable from Standard.

The single SDK still has the bundle-isolation flavor we apply to Cloudflare: `firegraph/cloudflare` re-exports `createRegistry`, `generateId`, etc. so workerd consumers don't have to import the root `firegraph` (which would pull in `@google-cloud/firestore`). Both `firestore-standard` and `firestore-enterprise` may safely depend on `@google-cloud/firestore` because that's the same package the user already installed; we don't need to fight bundles for them.

### Where the pipeline adapter lives

`src/internal/pipeline-adapter.ts` moves to `src/firestore-enterprise/pipeline-adapter.ts`. Standard never imports it. The dynamic-import lazy load in the current adapter is kept because pipelines is still optional inside Enterprise (some operations stay on classic, e.g. transactions, single-doc reads, listeners).

### `package.json` `exports` map (target)

```jsonc
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./backend": { "import": "./dist/backend.js", "types": "./dist/backend.d.ts" },
    "./firestore-standard": {
      "import": "./dist/firestore-standard/index.js",
      "types": "./dist/firestore-standard/index.d.ts",
    },
    "./firestore-enterprise": {
      "import": "./dist/firestore-enterprise/index.js",
      "types": "./dist/firestore-enterprise/index.d.ts",
    },
    "./sqlite": { "import": "./dist/sqlite/index.js", "types": "./dist/sqlite/index.d.ts" },
    "./cloudflare": {
      "import": "./dist/cloudflare/index.js",
      "types": "./dist/cloudflare/index.d.ts",
    },
    "./react": {
      /* unchanged */
    },
    "./svelte": {
      /* unchanged */
    },
    "./query-client": {
      /* unchanged */
    },
  },
}
```

`tsup` entries gain `src/firestore-standard/index.ts`, `src/firestore-enterprise/index.ts`, `src/sqlite/index.ts`. The root `src/index.ts` no longer re-exports any Firestore-specific code; it exposes only the portable surface.

## 6. Backend constructors

Each backend exports one constructor. The constructor returns a `StorageBackend<C>` parameterized on its declared capability set.

```ts
// firegraph/firestore-standard
export function createFirestoreStandardBackend(
  db: Firestore,
  collectionPath: string,
  options?: FirestoreStandardOptions,
): StorageBackend<FirestoreStandardCapabilities>;

export type FirestoreStandardCapabilities =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'search.vector'
  | 'realtime.listen'
  | 'raw.firestore';
```

```ts
// firegraph/firestore-enterprise
export function createFirestoreEnterpriseBackend(
  db: Firestore,
  collectionPath: string,
  options?: FirestoreEnterpriseOptions,
): StorageBackend<FirestoreEnterpriseCapabilities>;

export type FirestoreEnterpriseCapabilities =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  | 'search.fullText'
  | 'search.geo'
  | 'search.vector'
  | 'realtime.listen'
  | 'raw.firestore';

export interface FirestoreEnterpriseOptions {
  /**
   * Default execution mode for query primitives.
   *  - 'pipeline' (default): use pipelines for findNodes/findEdges
   *  - 'classic': use the classic Query API
   * Pipeline-only features (search, DML, join) always use pipelines regardless.
   */
  defaultQueryMode?: 'pipeline' | 'classic';
}
```

```ts
// firegraph/sqlite
export function createSqliteBackend(
  driver: SqliteDriver,
  options?: SqliteBackendOptions,
): StorageBackend<SqliteCapabilities>;

export type SqliteCapabilities =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  | 'raw.sql';
```

```ts
// firegraph/cloudflare
export function createDOBackend(
  state: DurableObjectState,
  options?: DOBackendOptions,
): StorageBackend<DOCapabilities>;

export type DOCapabilities = SqliteCapabilities; // identical surface
```

### `createGraphClient` and capability propagation

The client constructor accepts a backend and **infers** the capability set:

```ts
// src/index.ts (core)
export function createGraphClient<C extends Capability>(
  backend: StorageBackend<C>,
  options?: GraphClientOptions,
): GraphClient<C>;
```

`GraphClient<C>` is a conditional type that adds extension methods only when the relevant capability is in `C`. See §7.

### Dropped APIs

- `queryMode` is removed from the **core** options. It's a Firestore-Enterprise-only concern, expressed as `FirestoreEnterpriseOptions.defaultQueryMode`.
- Standard backend has no `queryMode` — there's only one mode, the classic Query API.
- The implicit emulator detection (`FIRESTORE_EMULATOR_HOST`) inside the backend constructor stays as a safety net **inside the Enterprise backend**: if the emulator host is set, force `defaultQueryMode: 'classic'` and emit a one-time `console.warn`. The Standard backend ignores it.

## 7. Type-level capability gating

The portable core type `GraphClient` is parameterized; extension surfaces are added by intersection only when the capability is present.

```ts
// src/types.ts
export interface CoreGraphClient {
  // GraphReader, GraphWriter, runTransaction, batch, subgraph — unchanged
  findEdges(params: FindEdgesParams): Promise<GraphRecord[]>;
  findNodes(params: FindNodesParams): Promise<GraphRecord[]>;
  // ...
}

export interface AggregateExtension {
  /** Run aggregate query (count/sum/avg/min/max) against a filter set. */
  aggregate<A extends AggregateSpec>(
    params: FindEdgesParams & { aggregates: A },
  ): Promise<AggregateResult<A>>;
}

export interface SelectExtension {
  /** Run a query returning only the requested data fields. */
  findEdgesProjected<F extends string>(
    params: FindEdgesParams & { select: F[] },
  ): Promise<Array<Pick<GraphRecord['data'], F>>>;
}

export interface JoinExtension {
  /**
   * Multi-hop fan-out with target-node hydration, executed in one round trip
   * when the backend supports it.
   */
  expand(params: ExpandParams): Promise<ExpandResult>;
}

export interface DmlExtension {
  /** Server-side conditional delete. Returns count of deleted records. */
  bulkDelete(params: FindEdgesParams): Promise<{ deleted: number }>;
  /** Server-side conditional update — applies a patch to all matching records. */
  bulkUpdate(params: FindEdgesParams, patch: BulkUpdatePatch): Promise<{ updated: number }>;
}

export interface FullTextSearchExtension {
  search(params: FullTextSearchParams): Promise<GraphRecord[]>;
}

export interface GeoExtension {
  searchByDistance(params: GeoSearchParams): Promise<GraphRecord[]>;
}

export interface VectorExtension {
  findNearest(params: FindNearestParams): Promise<GraphRecord[]>;
}

export interface RawFirestoreExtension {
  raw: {
    firestore: { db: Firestore; collectionPath: string };
  };
}

export interface RawSqlExtension {
  raw: {
    sql: SqlExecutor;
  };
}

// The conditional client type
export type GraphClient<C extends Capability = Capability> = CoreGraphClient &
  ('query.aggregate' extends C ? AggregateExtension : object) &
  ('query.select' extends C ? SelectExtension : object) &
  ('query.join' extends C ? JoinExtension : object) &
  ('query.dml' extends C ? DmlExtension : object) &
  ('search.fullText' extends C ? FullTextSearchExtension : object) &
  ('search.geo' extends C ? GeoExtension : object) &
  ('search.vector' extends C ? VectorExtension : object) &
  ('raw.firestore' extends C ? RawFirestoreExtension : object) &
  ('raw.sql' extends C ? RawSqlExtension : object);
```

### Why distributive conditionals work here

`'query.join' extends C ? JoinExtension : object` distributes over the union members of `C`. If `C` is `'core.read' | 'query.join'`, then `'query.join' extends C` evaluates to `JoinExtension`. If `C` is `'core.read'` alone, it evaluates to `object`. The intersection with `object` is a no-op, so methods only appear when the capability is in the set.

### Runtime parity

The runtime client implementation has every method defined; whether or not it's reachable is purely a type-level decision. **However**, calling an extension method on a backend that doesn't declare the capability throws a typed error:

```ts
// In the runtime impl:
search(params: FullTextSearchParams) {
  if (!this.backend.capabilities.has('search.fullText')) {
    throw new FiregraphError(
      'CAPABILITY_NOT_SUPPORTED',
      `Backend does not support 'search.fullText'. Available: ${[...this.backend.capabilities.values()].join(', ')}`,
    );
  }
  return this.searchImpl(params);
}
```

This is the "you cast it away" failure mode — if a user widens the type with `as`, the runtime check still catches it. The expected path is that the type system blocks the call.

### Capability-narrowed traversal

Helpers that need a specific capability to enable a fast path take the narrowed type:

```ts
// Internal — only callable when the backend can join
function planJoinTraversal(
  client: GraphClient<'query.join' | 'core.read'>,
  spec: TraversalSpec,
): JoinPlan {
  /* ... */
}
```

The planner inspects `client.backend.capabilities` and routes:

```ts
function traverse(client: GraphClient, spec: TraversalSpec) {
  if (client.backend.capabilities.has('query.join')) {
    return planJoinTraversal(client as GraphClient<'query.join' | 'core.read'>, spec);
  }
  return planPerHopTraversal(client, spec);
}
```

The cast is contained inside the planner. From the user's perspective, they call `traverse(client, spec)` with whatever client they have; the speedup is invisible.

## 8. Extension surfaces in detail

### 8.1 `query.aggregate`

```ts
type AggregateOp = 'count' | 'sum' | 'avg' | 'min' | 'max';
type AggregateSpec = Record<string, { op: AggregateOp; field?: string }>;
type AggregateResult<A extends AggregateSpec> = { [K in keyof A]: number };

// Usage
const stats = await client.aggregate({
  aType: 'tour',
  axbType: 'hasDeparture',
  aggregates: {
    total: { op: 'count' },
    avgPrice: { op: 'avg', field: 'price' },
  },
});
// stats = { total: 42, avgPrice: 199.5 }
```

**Backend implementations:**

- Firestore Standard: build a classic Query, call `.count()` for count-only specs; for sum/avg/min/max, call `runAggregationQuery` (the SDK exposes `AggregateField.count`, `.sum`, `.average`).
- Firestore Enterprise: pipeline `aggregate()` stage, single round trip.
- SQLite / DO: SQL `SELECT COUNT(*), AVG(json_extract(data, '$.price')) FROM ...`.

### 8.2 `query.select`

```ts
type ProjectedRecord<F extends string> = Pick<StoredGraphRecord['data'], F>;

const titles = await client.findEdgesProjected({
  aType: 'tour',
  axbType: 'hasDeparture',
  select: ['title', 'date'],
});
```

**Backend implementations:**

- Firestore Standard: classic field mask via `select(...)` on `Query`.
- Firestore Enterprise: pipeline `select()` stage.
- SQLite / DO: SQL `SELECT json_extract(data, '$.title') AS title ...`.

### 8.3 `query.join` — multi-hop expansion

The join extension is the big traversal win. It expresses "starting from these uids, follow these edges, and hydrate target nodes" in one server round trip when the backend supports it.

```ts
interface ExpandParams {
  fromUids: string[];
  hops: ExpandHop[];
  /** Hydrate target nodes? Default true. */
  includeTargets?: boolean;
}
interface ExpandHop {
  axbType: string;
  bType?: string;
  /** Optional filter on edge.data fields. */
  where?: WhereClause[];
  /** Limit per source uid. */
  limitPerSource?: number;
}
interface ExpandResult {
  edges: GraphRecord[];
  nodes: GraphRecord[];
}
```

**Backend implementations:**

- Firestore Enterprise: emit one pipeline per hop depth; each pipeline does `collection.where(aUid in [...]).where(axbType==).limit(...)` then a subquery to fetch target nodes by `bUid`. Subqueries are GA per the April 2026 announcement.
- SQLite / DO: SQL with recursive uid set; each depth a single `SELECT ... WHERE aUid IN (...) UNION SELECT n.* FROM nodes n WHERE n.uid IN (...)`.
- Standard / non-join backends: not present on the type; planner falls back to per-hop loop in `traverse.ts`.

### 8.4 `query.dml` — server-side conditional writes

```ts
const { deleted } = await client.bulkDelete({
  aType: 'tour',
  aUid: 'Kj7vNq2mP9xR4wL1tY8s3',
  axbType: 'hasDeparture',
});
// All matching edge docs deleted server-side, no client iteration.

const { updated } = await client.bulkUpdate(
  {
    aType: 'tour',
    axbType: 'hasDeparture',
    where: [{ field: 'data.draft', op: '==', value: true }],
  },
  { dataOps: [{ path: ['draft'], op: 'set', value: false }] },
);
```

**Backend implementations:**

- Firestore Enterprise: pipeline `.update()` / `.delete()` stage following `where()`.
- SQLite / DO: SQL `UPDATE ... WHERE ...` / `DELETE FROM ... WHERE ...`. The existing `flattenPatch` / `DataPathOp` write-plan pipeline ([src/internal/write-plan.ts](../src/internal/write-plan.ts)) is reused for `dataOps`.
- Standard: not declared. Existing per-row delete loop in `bulk.ts` remains the only path on Standard.

### 8.5 `search.*` extensions

```ts
interface FullTextSearchParams {
  aType?: string;
  bType?: string;
  query: string; // search string
  fields?: string[]; // optional restriction to specific data fields
  limit?: number;
}
```

Pipeline `.search()` must be the first stage, so combining `aType` filters with FTS requires emitting the `search()` stage scoped to a typed collection or post-filtering. Implementation note: when `aType` is supplied, route through the per-type collection path (already part of the graph's storage layout) so FTS scopes correctly.

`search.geo` and `search.vector` follow the same pattern; their parameter shapes mirror Firestore's pipeline stage signatures.

### 8.6 `raw.*` escape hatches

Power users get an explicit escape hatch:

```ts
// Enterprise / Standard
client.raw.firestore.db          // the underlying Firestore handle
client.raw.firestore.collectionPath

// SQLite / DO
client.raw.sql.execute(sql, params): Promise<unknown[]>
```

Documented as: "you've left the firegraph abstraction. Portability is your problem." Useful for one-off queries that don't yet have a first-class capability.

## 9. Query planner & traversal integration

The planner is the place where capabilities pay off. The user-facing API stays portable; the planner picks the fastest implementation the backend supports.

### Files affected

- [src/query.ts](../src/query.ts) — add capability checks to `buildEdgeQueryPlan` / `buildNodeQueryPlan`. Existing GET-vs-QUERY logic is unchanged.
- [src/traverse.ts](../src/traverse.ts) — branches on `query.join` capability to use `expand()` per depth vs. per-hop loop.
- [src/bulk.ts](../src/bulk.ts) — branches on `query.dml` for cascade deletes.

### Planner contract

Each planner function receives the backend's capability set and returns one of a small set of execution plans:

```ts
type Plan =
  | { kind: 'get'; docId: string }
  | { kind: 'query'; filters: QueryFilter[]; options: QueryOptions }
  | { kind: 'aggregate'; spec: AggregateSpec; filters: QueryFilter[] }
  | { kind: 'expand'; spec: ExpandParams }
  | { kind: 'dml-delete'; filters: QueryFilter[] }
  | { kind: 'dml-update'; filters: QueryFilter[]; patch: UpdatePayload };

function planFindEdges(caps: BackendCapabilities, params: FindEdgesParams): Plan {
  /* picks 'get' if all 3 ids present, else 'query' */
}

function planTraversal(caps: BackendCapabilities, spec: TraversalSpec): Plan[] {
  // If caps.has('query.join'): emit one 'expand' per depth.
  // Else: emit per-hop 'query' plans wrapped by the existing semaphore loop.
}
```

The backend's `query()` / `expand()` / `bulkDelete()` methods receive these plans and execute them with the right SDK call.

## 10. Cross-backend invariants

These are non-negotiable rules that must hold after the refactor:

1. **Every `core.*` capability test passes on every backend.** A test of `findEdges` runs against `[firestore-standard, firestore-enterprise, sqlite, do]` and produces identical observable results.
2. **No backend silently demotes a capability.** If Cloudflare DO can't yet produce identical `query.join` semantics to Firestore Enterprise, it does **not** declare `query.join`. We add it later.
3. **Capability declarations are static.** A backend's `capabilities` set is fixed at construction; it doesn't depend on the schema, registry, or runtime state.
4. **Cross-backend writes share the same write-plan pipeline.** [src/internal/write-plan.ts](../src/internal/write-plan.ts) (`flattenPatch`, `DataPathOp`, `deleteField`) remains the single source of truth for the deep-merge contract. SQLite and DO continue to enforce `assertJsonSafePayload` ([src/internal/sqlite-payload-guard.ts](../src/internal/sqlite-payload-guard.ts)) at the write boundary; Firestore backends do not.
5. **The routing backend (`src/internal/routing-backend.ts`) intersects child capabilities.** A graph mounted across multiple backends declares the **intersection** of child capability sets. Users who want pipeline FTS on a graph that has an SQLite child cannot — the routing backend reports `search.fullText: false`.
6. **No subpath imports another subpath's vendor SDK.** `firegraph/sqlite` does not import `@google-cloud/firestore`. `firegraph/firestore-*` does not import `better-sqlite3`. Same hygiene as today's `firegraph/cloudflare`.
7. **Transactions stay on classic.** Pipeline-in-transaction is "coming soon" per the GA announcement but not yet supported. The `TransactionBackend` interface keeps using the classic Query API on Firestore Enterprise.
8. **`onSnapshot` is gated by `realtime.listen`.** Today firegraph has no listener API; if a future API adds one, it must declare `realtime.listen`. Enterprise backends declare it but route listeners through the **classic** API, never pipelines.

## 11. Failure modes & error messages

When a runtime call hits an unsupported capability (because the user widened the type), throw a typed error:

```ts
// src/errors.ts
export class CapabilityNotSupportedError extends FiregraphError {
  readonly code = 'CAPABILITY_NOT_SUPPORTED';
  constructor(missing: Capability, available: Capability[]) {
    super(
      `Backend does not declare capability '${missing}'. ` +
        `Available capabilities: ${available.sort().join(', ')}. ` +
        `Use a backend that declares '${missing}', or remove the call.`,
    );
  }
}
```

Standard error shape across all backends. The `available` array helps the user understand what they have and what they need to switch to.

For pipeline-call-against-Standard-database (a user gets an Enterprise backend pointed at a Standard DB), the underlying Firestore SDK raises a `FAILED_PRECONDITION` with a server error message. We pass it through unwrapped — that's a deployment / configuration mistake, not a firegraph contract violation. The error message from the SDK is sufficient.

## 12. Naming conventions & file layout

### Source layout

```
src/
  index.ts                         # core exports (no Firestore, no SQLite)
  types.ts                         # Capability union, BackendCapabilities, GraphClient<C>, etc.
  client.ts                        # GraphClientImpl — capability-parameterized
  query.ts                         # planner — capability-aware
  traverse.ts                      # capability-aware fast paths
  bulk.ts                          # capability-aware DML
  registry.ts, dynamic-registry.ts # unchanged surface
  views.ts, react.ts, svelte.ts    # unchanged
  internal/
    backend.ts                     # StorageBackend<C>, BackendCapabilities, capability constants
    write-plan.ts                  # unchanged
    routing-backend.ts             # capability intersection logic
    sqlite-payload-guard.ts        # unchanged
    serialization-tag.ts           # unchanged
    pipeline-adapter.ts            # DELETED — moves to firestore-enterprise/
  firestore-standard/
    index.ts                       # createFirestoreStandardBackend, FirestoreStandardCapabilities
    backend.ts                     # backend impl using classic Query API only
    aggregate.ts                   # runAggregationQuery wrapper
  firestore-enterprise/
    index.ts                       # createFirestoreEnterpriseBackend, ...Capabilities
    backend.ts                     # backend impl with pipeline + classic dual mode
    pipeline-adapter.ts            # moved from src/internal/
    pipeline-aggregate.ts          # aggregate() stage builder
    pipeline-expand.ts             # join / expand pipeline builder
    pipeline-dml.ts                # update / delete stage builders
    pipeline-search.ts             # search() stage
    pipeline-geo.ts                # geo stages
    pipeline-vector.ts             # findNearest stage
  sqlite/
    index.ts                       # createSqliteBackend, SqliteCapabilities
    backend.ts                     # SQLite implementation
    sql.ts                         # current src/internal/sqlite-sql.ts moves here
  cloudflare/
    index.ts                       # unchanged surface, but declares DOCapabilities
    do.ts, backend.ts, sql.ts      # unchanged file paths
```

### Naming

- Backend constructors: `create{Edition}{Backend}Backend` (e.g. `createFirestoreEnterpriseBackend`). Verbose, symmetric, explicit. Avoid abbreviations.
- Capability strings: `domain.feature` lowercase dot-separated (`query.aggregate`, `search.fullText`). Camel-case the second segment.
- Capability type aliases: `{Backend}Capabilities` (e.g. `FirestoreStandardCapabilities`).
- Extension interfaces: `{Capability}Extension` (e.g. `AggregateExtension`).
- Error codes: `SCREAMING_SNAKE` (`CAPABILITY_NOT_SUPPORTED`).

### Tests layout

```
tests/
  unit/                              # backend-agnostic unit tests
  integration/                       # NEW: parameterized over [firestore-standard, firestore-enterprise, sqlite, do]
    _harness.ts                      # capability matrix harness
    core/                            # tests for core.* capabilities (run on all backends)
    query-aggregate/                 # run on backends with query.aggregate
    query-join/                      # run on backends with query.join
    query-dml/                       # run on backends with query.dml
    search-full-text/                # run on backends with search.fullText
    search-geo/                      # run on backends with search.geo
    search-vector/                   # run on backends with search.vector
  legacy/                            # the current tests/integration/ + tests/integration-pipeline/ are merged into the harness; anything not portable lands here temporarily
```

The harness reads the backend's declared capability set and skips suites whose capability isn't present. Adding a new capability to a backend is one line in the harness.

## 13. Alternatives considered

### Single backend with runtime feature flags

Rejected. Capability detection at runtime (e.g. probing the database with a pipeline call and catching the error) is fragile, slow, and depends on network state at construction time. It also fails the type-level gating principle — every extension method becomes a `Promise<T | CapabilityError>` in spirit, even when the backend definitely supports it.

### Edition as a runtime config option

```ts
createFirestoreBackend(db, path, { edition: 'enterprise' });
```

Rejected. Same problem as feature flags — the type system can't tell the two apart. Two `FirestoreBackend` instances would have different capability sets but indistinguishable types. Discriminating return types on a string parameter is possible (string-literal generics) but the resulting types are fiddly and hard to compose.

### Capability detection via test queries

Rejected. Same reasoning as feature flags, plus billable read costs at every backend construction.

### Pipeline-only Enterprise backend (no classic fallback)

Rejected. Pipelines lack onSnapshot, lack transactional support, and are slower for vector search. We need the classic Query API alongside pipelines on Enterprise. The default mode is configurable per `FirestoreEnterpriseOptions.defaultQueryMode`.

### Keep Firestore as a single subpath, gate at the constructor

```ts
createFirestoreBackend(db, path, { edition: 'standard' | 'enterprise' });
```

Rejected for the same reason as above — no type discrimination.

### Capability set as an opaque string

```ts
backend.supports('query.join'); // returns boolean
```

Rejected as the **only** mechanism — runtime-only checks defeat strict typing. We do keep `capabilities.has(...)` for runtime checks (planner needs them), but the type system is the primary gate.

## 14. Out of scope (this PR)

- Editor UI changes for FTS / vector / geo. Tracked as a follow-on PR.
- MongoDB-compatible Enterprise mode. Out of scope per maintainer decision.
- SQLite FTS5 / R\*Tree integration to opt SQLite into `search.fullText` / `search.geo`. Possible future work.
- Pipeline-in-transaction support. Pending Firestore SDK GA.
- A capability-aware GraphQL or REST surface. Future.

## 15. Open questions / explicit non-decisions

- **`query.select` ergonomics.** The current proposal returns `Pick<StoredGraphRecord['data'], F>` keyed by the literal field tuple. If users frequently want both projection and full record metadata (aType, aUid, etc.), we may need a `select: { data: ['title'], envelope: ['aUid'] }` shape. Implementer should pick the simplest shape that covers the editor's known consumers.
- **`query.aggregate` group-by.** Pipelines support grouped aggregations; the classic API doesn't have `runAggregationQuery` group-by. If we want grouped aggregations as a portable capability, we'd need to declare a separate `query.aggregate.grouped` capability. For this PR, only un-grouped aggregations are in scope.
- **`expand` shape vs. existing `traverse`.** The `expand` extension and the existing `traverse` builder do similar things. The implementation should keep both: `traverse` is the high-level builder that compiles down to either `expand` calls (capable backends) or per-hop `findEdges` loops (others). Don't expose `expand` as the user's primary API.
