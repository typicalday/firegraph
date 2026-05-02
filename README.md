# Firegraph

> **Warning:** This library is experimental. APIs may change without notice between releases.

A typed graph data layer for Firebase Cloud Firestore. Store nodes and edges as triples in a Firestore collection with smart query planning, sharded document IDs, optional schema validation, multi-hop traversal, and nested subgraphs.

## Install

```bash
npm install firegraph
# or
pnpm add firegraph
```

Firegraph requires `@google-cloud/firestore` `^8.0.0` as a peer dependency. npm 7+ and pnpm auto-install peer deps, so this is typically handled for you.

When installing from git (not npm), firegraph builds itself via a `prepare` script. The consuming project needs `tsup` and `typescript` as dev dependencies:

```bash
npm install -D tsup typescript
```

**pnpm 10+** blocks dependency build scripts by default. Allow `firegraph` and `esbuild` in your `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "firegraph"]
  }
}
```

## Quick Start

```typescript
import { Firestore } from '@google-cloud/firestore';
import { createGraphClient, generateId } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';

const db = new Firestore();
const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend);

// Create nodes
const tourId = generateId();
await g.putNode('tour', tourId, { name: 'Dolomites Classic', difficulty: 'hard' });

const depId = generateId();
await g.putNode('departure', depId, { date: '2025-07-15', maxCapacity: 30 });

// Create an edge
await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 0 });

// Query edges
const departures = await g.findEdges({ aUid: tourId, axbType: 'hasDeparture' });
```

## Core Concepts

### Graph Model

Firegraph stores everything as **triples** in a Firestore collection (with optional nested subcollections for [subgraphs](#subgraphs)):

```
(aType, aUid) -[axbType]-> (bType, bUid)
```

- **Nodes** are self-referencing edges with the special relation `is`:
  `(tour, Kj7vNq2mP9xR4wL1tY8s3) -[is]-> (tour, Kj7vNq2mP9xR4wL1tY8s3)`
- **Edges** are directed relationships between nodes:
  `(tour, Kj7vNq2mP9xR4wL1tY8s3) -[hasDeparture]-> (departure, Xp4nTk8qW2vR7mL9jY5a1)`

Every record carries a `data` payload (arbitrary JSON), plus `createdAt` and `updatedAt` server timestamps. Records managed by a schema registry with migrations also carry a `v` field (schema version number, derived from `max(toVersion)` of the migrations array) on the record envelope.

### Document IDs

UIDs **must** be generated via `generateId()` (21-char nanoid). Short sequential strings like `tour1` create Firestore write hotspots.

- **Nodes**: The UID itself (e.g., `Kj7vNq2mP9xR4wL1tY8s3`)
- **Edges**: `shard:aUid:axbType:bUid` where the shard prefix (0–f) is derived from SHA-256, distributing writes across 16 buckets to avoid Firestore hotspots

## API Reference

### Creating a Client

```typescript
import { createGraphClient } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';
// or for Enterprise Firestore (Pipelines, DML, server-side traversal, FTS, geo):
import { createFirestoreEnterpriseBackend } from 'firegraph/firestore-enterprise';

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend);
// or with options:
const g = createGraphClient(backend, { registry });
```

For non-Firestore backends (SQLite, Cloudflare DO, routing backend) use `createGraphClientFromBackend`, which accepts any raw `StorageBackend<C>` without requiring a named factory:

```typescript
import { createGraphClientFromBackend } from 'firegraph';
const g = createGraphClientFromBackend(backend, opts, metaBackend);
```

`createGraphClientFromBackend` is a deprecated alias for `createGraphClient` — prefer `createGraphClient` directly. Both accept the same `opts` and `metaBackend` arguments.

**Parameters:**

- `backend` — A `StorageBackend<C>` from `createFirestoreStandardBackend`, `createFirestoreEnterpriseBackend`, or another backend factory
- `opts.registry` — Optional `GraphRegistry` for schema validation
- `opts.registryMode` — Optional dynamic registry config (`{ mode: 'dynamic', collection? }`). Pass alongside `opts.registry` for merged mode (static + dynamic).
- `opts.migrationWriteBack` — Optional global write-back mode (`'off'` | `'eager'` | `'background'`)
- `opts.migrationSandbox` — Optional custom migration evaluator (overrides the default SES executor)
- `opts.queryMode` — Optional Firestore query backend (`'pipeline'` | `'standard'`; default `'pipeline'`). Ignored by non-Firestore backends.
- `opts.scanProtection` — Optional full-collection-scan gate (`'off'` | `'warn'` | `'error'`; default `'error'`)
- `metaBackend` — Optional separate backend for meta-type storage (dynamic registry)

### Capability System

Every client exposes a `capabilities` property (a `BackendCapabilities` set) that reflects what the underlying backend supports. Use it for portable feature checks at runtime:

```typescript
if (client.capabilities.has('query.join')) {
  const result = await (client as JoinExtension).expand({ ... });
}
```

`GraphClient<C>` is a generic type — the type parameter `C` is a union of the backend's declared `Capability` strings and controls which extension methods are present on the type. `CoreGraphClient` is the unconditional base (read + write + transactions + batch + subgraph + `capabilities`). Helper functions that should accept any client should be typed to `CoreGraphClient` or `GraphReader`/`GraphWriter`.

**Capability values:**

| Capability                                                  | Methods unlocked                                                 | Backends                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `core.read` / `core.write` / `core.batch` / `core.subgraph` | `getNode`, `putNode`, `findEdges`, `batch()`, `subgraph()`, etc. | All                                                                                                                                      |
| `core.transactions`                                         | `runTransaction(fn)`                                             | Firestore (both), SQLite (`better-sqlite3` only; absent on D1); **absent on Cloudflare DO**                                              |
| `query.aggregate`                                           | `aggregate(spec)`                                                | All; `min`/`max` only on SQLite + DO (both Firestore editions reject `min`/`max` — classic `Query.aggregate` exposes only count/sum/avg) |
| `query.select`                                              | `findEdgesProjected(params)`                                     | All                                                                                                                                      |
| `query.join`                                                | `expand(params)`                                                 | All                                                                                                                                      |
| `query.dml`                                                 | `bulkDelete(params)`, `bulkUpdate(params)`                       | Enterprise (requires `previewDml: true`), SQLite, DO                                                                                     |
| `traversal.serverSide`                                      | `runEngineTraversal(params)`                                     | Enterprise                                                                                                                               |
| `search.vector`                                             | `findNearest(params)`                                            | Firestore (both)                                                                                                                         |
| `search.fullText`                                           | `fullTextSearch(params)`                                         | Enterprise. **Note:** the `fields` option is not yet supported — passing a non-empty `fields` array throws `INVALID_QUERY`.              |
| `search.geo`                                                | `geoSearch(params)`                                              | Enterprise                                                                                                                               |
| `raw.firestore`                                             | _(reserved — no methods yet)_                                    | Firestore (both)                                                                                                                         |
| `raw.sql`                                                   | _(reserved — no methods yet)_                                    | SQLite                                                                                                                                   |
| `realtime.listen`                                           | _(reserved — no methods yet)_                                    | _(none currently)_                                                                                                                       |

### Nodes

```typescript
const tourId = generateId();

// Create or deep-merge a node (sibling keys at any depth survive)
await g.putNode('tour', tourId, { name: 'Dolomites Classic' });

// Read a node
const node = await g.getNode(tourId);
// → StoredGraphRecord | null

// Partial update (deep merge into data)
await g.updateNode(tourId, { difficulty: 'extreme' });

// Full replace — discards every prior key not in the new payload
await g.replaceNode('tour', tourId, { name: 'Dolomites — 2026 Edition' });

// Delete a node
await g.removeNode(tourId);

// Find all nodes of a type
const tours = await g.findNodes({ aType: 'tour' });
```

**Write semantics (0.12+):** `putNode`/`putEdge` and `updateNode`/`updateEdge`
**deep-merge** by default — sibling keys at every nesting depth survive. Use
`replaceNode`/`replaceEdge` when you want the old "wipe and rewrite" behaviour.
Arrays are terminal (replaced wholesale, not element-merged); `undefined`
values are skipped; `null` is preserved verbatim; and the
[`deleteField()`](#field-deletion) sentinel removes a field at any depth.

### Edges

```typescript
const depId = generateId();

// Create or deep-merge an edge
await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 0 });

// Read a specific edge
const edge = await g.getEdge(tourId, 'hasDeparture', depId);
// → StoredGraphRecord | null

// Check existence
const exists = await g.edgeExists(tourId, 'hasDeparture', depId);

// Partial update (deep merge)
await g.updateEdge(tourId, 'hasDeparture', depId, { order: 5 });

// Full replace — discards every prior key not in the new payload
await g.replaceEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 5 });

// Delete an edge
await g.removeEdge(tourId, 'hasDeparture', depId);

// Bulk delete all edges matching a filter (available on all backends)
const result = await g.bulkRemoveEdges({ aUid: tourId, axbType: 'hasDeparture' });
// → BulkResult { deleted: number, errors: BulkBatchError[] }
```

### Field Deletion

The `deleteField()` sentinel removes a field from a stored document. It works
across every backend (Firestore, SQLite, Cloudflare Durable Objects), so
calling code stays portable:

```typescript
import { deleteField } from 'firegraph';

await g.updateNode(tourId, {
  meta: { deprecatedTag: deleteField() }, // removes meta.deprecatedTag
});
```

Equivalent to Firestore's `FieldValue.delete()`, but Workers-safe and
SQLite-aware.

### Querying Edges

`findEdges` accepts any combination of filters. When all three identifiers (`aUid`, `axbType`, `bUid`) are provided, it uses a direct document lookup instead of a query scan.

```typescript
// Forward: all departures of a tour
await g.findEdges({ aUid: tourId, axbType: 'hasDeparture' });

// Reverse: all tours that have this departure
await g.findEdges({ axbType: 'hasDeparture', bUid: depId });

// Type-scoped: all hasDeparture edges from any tour
await g.findEdges({ aType: 'tour', axbType: 'hasDeparture' });

// With limit and ordering
await g.findEdges({
  aUid: tourId,
  axbType: 'hasDeparture',
  limit: 5,
  orderBy: { field: 'data.order', direction: 'asc' },
});
```

### Transactions

Full read-write transactions with automatic retry:

```typescript
await g.runTransaction(async (tx) => {
  const dep = await tx.getNode(depId);
  const count = (dep?.data.registeredRiders as number) || 0;

  if (count < 30) {
    await tx.putEdge('departure', depId, 'hasRider', 'rider', riderId, {});
    await tx.updateNode(depId, { registeredRiders: count + 1 });
  }
});
```

The transaction object (`tx`) has the same read/write methods as the client. Writes are synchronous within the transaction and committed atomically.

### Batches

Atomic batch writes (no reads):

```typescript
const batch = g.batch();
const aliceId = generateId();
const bobId = generateId();
await batch.putNode('rider', aliceId, { name: 'Alice' });
await batch.putNode('rider', bobId, { name: 'Bob' });
await batch.putEdge('rider', aliceId, 'friends', 'rider', bobId, {});
await batch.commit();
```

### Graph Traversal

Multi-hop traversal with budget enforcement, concurrency control, in-memory filtering, and cross-graph hops:

```typescript
import { createTraversal } from 'firegraph';

// Tour → Departures → Riders (2 hops)
const result = await createTraversal(g, tourId)
  .follow('hasDeparture', { limit: 5, bType: 'departure' })
  .follow('hasRider', {
    limit: 20,
    filter: (edge) => edge.data.status === 'confirmed',
  })
  .run({ maxReads: 200, returnIntermediates: true });

result.nodes; // StoredGraphRecord[] — edges from the final hop
result.hops; // HopResult[] — per-hop breakdown
result.totalReads; // number — Firestore reads consumed
result.truncated; // boolean — true if budget was hit
```

`createTraversal` accepts a `GraphClient` or `GraphReader`. When passed a `GraphClient`, cross-graph hops via `targetGraph` are supported (see [Cross-Graph Edges](#cross-graph-edges)).

#### Reverse Traversal

Walk edges backwards to find parents:

```typescript
// Rider → Departures → Tours
const result = await createTraversal(g, riderId)
  .follow('hasRider', { direction: 'reverse' })
  .follow('hasDeparture', { direction: 'reverse' })
  .run();

// result.nodes contains the tour edges
```

#### Traversal in Transactions

```typescript
await g.runTransaction(async (tx) => {
  const result = await createTraversal(tx, tourId).follow('hasDeparture').follow('hasRider').run();
  // Use result to make transactional writes...
});
```

#### Hop Options

| Option        | Type                     | Default     | Description                                                                        |
| ------------- | ------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `direction`   | `'forward' \| 'reverse'` | `'forward'` | Edge direction                                                                     |
| `aType`       | `string`                 | —           | Filter source node type                                                            |
| `bType`       | `string`                 | —           | Filter target node type                                                            |
| `limit`       | `number`                 | `10`        | Max edges per source node                                                          |
| `orderBy`     | `{ field, direction? }`  | —           | Firestore-level ordering                                                           |
| `filter`      | `(edge) => boolean`      | —           | In-memory post-filter                                                              |
| `targetGraph` | `string`                 | —           | Subgraph to cross into (forward only). See [Cross-Graph Edges](#cross-graph-edges) |

#### Run Options

| Option                | Type                         | Default  | Description                                                                                                                                  |
| --------------------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxReads`            | `number`                     | `100`    | Total read budget                                                                                                                            |
| `concurrency`         | `number`                     | `5`      | Max parallel queries per hop                                                                                                                 |
| `returnIntermediates` | `boolean`                    | `false`  | Include edges from all hops                                                                                                                  |
| `engineTraversal`     | `'auto' \| 'force' \| 'off'` | `'auto'` | Engine-level traversal on Enterprise backends. `'auto'` silently falls back if ineligible; `'force'` throws if unavailable; `'off'` disables |

When `filter` is set, the `limit` is applied after filtering (in-memory), so Firestore returns all matching edges and the filter + slice happens client-side.

### Schema Registry

Optional type validation using Zod (or any object with a `.parse()` method):

```typescript
import { createRegistry, createGraphClient } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';
import { z } from 'zod';

const registry = createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    dataSchema: z.object({
      name: z.string(),
      difficulty: z.enum(['easy', 'medium', 'hard']),
    }),
  },
  {
    aType: 'tour',
    axbType: 'hasDeparture',
    bType: 'departure',
    // No dataSchema = any data allowed for this edge type
  },
]);

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// This validates against the registry before writing:
const id = generateId();
await g.putNode('tour', id, { name: 'Alps', difficulty: 'hard' }); // OK
await g.putNode('tour', id, { name: 123 }); // throws ValidationError

// Unregistered triples are rejected:
await g.putEdge('tour', id, 'unknownRel', 'x', generateId(), {}); // throws RegistryViolationError
```

### Dynamic Registry

For agent-driven or runtime-extensible schemas, firegraph supports a **dynamic registry** where node and edge types are defined as graph data itself (meta-nodes). The workflow is: **define → reload → write**.

```typescript
import { createGraphClient } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, {
  registryMode: { mode: 'dynamic' },
});

// 1. Define types (stored as meta-nodes in the graph)
await g.defineNodeType('tour', {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
});

await g.defineEdgeType(
  'hasDeparture',
  { from: 'tour', to: 'departure' },
  { type: 'object', properties: { order: { type: 'number' } } },
);

// 2. Compile the registry from stored definitions
await g.reloadRegistry();

// 3. Write domain data — validated against the compiled registry
const tourId = generateId();
await g.putNode('tour', tourId, { name: 'Dolomites Classic' }); // OK
await g.putNode('booking', generateId(), { total: 500 }); // throws RegistryViolationError
```

Key behaviors:

- **Before `reloadRegistry()`**: Domain writes are rejected. Only meta-type writes (`defineNodeType`, `defineEdgeType`) are allowed.
- **After `reloadRegistry()`**: Domain writes are validated against the compiled registry. Unknown types are always rejected.
- **Upsert semantics**: Calling `defineNodeType('tour', ...)` twice overwrites the previous definition. After reloading, the latest schema is used.
- **Separate collection**: Meta-nodes can be stored in a different collection via `registryMode: { mode: 'dynamic', collection: 'meta' }`.
- **Merged mode**: Pass both `registry` (the static side, typically built via `createRegistry` or `createMergedRegistry`) and `registryMode: { mode: 'dynamic' }`. Firegraph then merges them — static entries take priority and dynamic definitions can only add new types, never override existing ones. There is no separate `mode: 'merged'` value; merged behavior is implied by supplying both options together.

Dynamic registry returns a `DynamicGraphClient` which extends `GraphClient` with `defineNodeType()`, `defineEdgeType()`, and `reloadRegistry()`. Transactions and batches also validate against the compiled dynamic registry.

### Schema Versioning & Auto-Migration

Firegraph supports schema versioning with automatic migration of records on read. The schema version is derived automatically as `max(toVersion)` from the `migrations` array -- there is no separate `schemaVersion` property to set. When a record's stored version (`v`) is behind the derived version, migration functions run automatically to bring data up to the current version.

```typescript
import { createRegistry, createGraphClient } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';
import type { MigrationStep } from 'firegraph';

const migrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
  { fromVersion: 1, toVersion: 2, up: async (d) => ({ ...d, active: true }) },
];

const registry = createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    jsonSchema: tourSchemaV2,
    migrations, // version derived as max(toVersion) = 2
    migrationWriteBack: 'eager',
  },
]);

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// Reading a v0 record automatically migrates it to v2 in memory
const tour = await g.getNode(tourId);
// tour.v === 2, tour.data.status === 'draft', tour.data.active === true
```

#### How It Works

- **Version storage**: The `v` field lives on the record envelope (top-level, alongside `aType`, `data`, etc.), not inside `data`. Records without `v` are treated as version 0 (legacy data).
- **Read path**: When a record is read and its `v` is behind the derived version (`max(toVersion)` from migrations), migrations run sequentially to bring data up to the current version.
- **Write path**: When writing via `putNode`/`putEdge` (deep-merge) or `replaceNode`/`replaceEdge` (full overwrite), the record is stamped with `v` equal to the derived version automatically.
- **`updateNode` / `updateEdge`**: Do not stamp `v` — they are raw partial patches without schema context. The next read re-triggers migration (which is idempotent).

#### Write-Back

Write-back controls whether migrated data is persisted back to Firestore after a read-triggered migration:

| Mode           | Behavior                                                        |
| -------------- | --------------------------------------------------------------- |
| `'off'`        | In-memory only; Firestore document unchanged (default)          |
| `'eager'`      | Fire-and-forget write after read; inline update in transactions |
| `'background'` | Same as eager but errors are swallowed with a `console.warn`    |

Resolution order: `entry.migrationWriteBack > client.migrationWriteBack > 'off'`

```typescript
// Global default
const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, {
  registry,
  migrationWriteBack: 'background',
});

// Entry-level override (takes priority)
createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    migrations,
    migrationWriteBack: 'eager',
  },
]);
```

#### Dynamic Registry Migrations

In dynamic mode, migrations are stored as source code strings:

```typescript
await g.defineNodeType('tour', tourSchema, 'A tour', {
  migrations: [{ fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, status: "draft" })' }],
  migrationWriteBack: 'eager',
});
await g.reloadRegistry();
```

Stored migration strings must be self-contained — no `import`, `require`, or external references. Firestore special types (`Timestamp`, `GeoPoint`, `VectorValue`, `DocumentReference`) are transparently preserved through the sandbox boundary via tagged serialization. Inside the sandbox, these appear as tagged plain objects (e.g., `{ __firegraph_ser__: 'Timestamp', seconds: N, nanoseconds: N }`) that the migration can read, modify, or create. They are reconstructed into real Firestore types after the migration returns.

For custom sandboxing, pass `migrationSandbox` to `createGraphClient()`:

```typescript
const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, {
  registryMode: { mode: 'dynamic' },
  migrationSandbox: (source) => {
    const compartment = new Compartment({
      /* endowments */
    });
    return compartment.evaluate(source);
  },
});
```

#### Entity Discovery

Place a `migrations.ts` file in the entity folder. It must default-export a `MigrationStep[]` array. Optionally set `migrationWriteBack` in `meta.json`. The schema version is derived automatically as `max(toVersion)` from the migrations array.

```
entities/nodes/tour/
  schema.json
  migrations.ts       # export default [{ fromVersion: 0, toVersion: 1, up: ... }]
  meta.json           # { "migrationWriteBack": "eager" }
```

### Subgraphs

Create isolated graph namespaces inside a parent node's Firestore document as subcollections. Each subgraph is a full `GraphClient` scoped to its own collection path.

```typescript
const agentId = generateId();
await g.putNode('agent', agentId, { name: 'ResearchBot' });

// Create a subgraph under the agent's document
const memories = g.subgraph(agentId, 'memories');

// CRUD works exactly like the parent client
const memId = generateId();
await memories.putNode('memory', memId, { text: 'The sky is blue' });
const mem = await memories.getNode(memId);

// Subgraph data is isolated — parent can't see it
const parentNodes = await g.findNodes({ aType: 'memory', allowCollectionScan: true });
// → [] (empty — memories live in the subcollection)
```

#### Nested Subgraphs

Subgraphs can be nested to any depth:

```typescript
const workspace = g.subgraph(agentId, 'workspace');
const taskId = generateId();
await workspace.putNode('task', taskId, { name: 'Analyze data' });

// Nest further
const subtasks = workspace.subgraph(taskId, 'subtasks');
await subtasks.putNode('subtask', generateId(), { name: 'Parse CSV' });
```

#### Scope Constraints (`allowedIn`)

Registry entries support `allowedIn` patterns that restrict where a type can be used:

```typescript
const registry = createRegistry([
  { aType: 'agent', axbType: 'is', bType: 'agent', allowedIn: ['root'] },
  { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['**/memories'] },
  { aType: 'task', axbType: 'is', bType: 'task', allowedIn: ['workspace', '**/workspace'] },
]);

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// Agent only at root
await g.putNode('agent', agentId, {}); // OK
await memories.putNode('agent', generateId(), {}); // throws RegistryScopeError

// Memory only in 'memories' subgraphs
await memories.putNode('memory', generateId(), {}); // OK
await g.putNode('memory', generateId(), {}); // throws RegistryScopeError
```

**Pattern syntax:**

| Pattern           | Matches                            |
| ----------------- | ---------------------------------- |
| `root`            | Top-level collection only          |
| `memories`        | Exact subgraph name                |
| `workspace/tasks` | Exact path                         |
| `*/memories`      | `*` matches one segment            |
| `**/memories`     | `**` matches zero or more segments |
| `**`              | Everything including root          |

Omitting `allowedIn` (or passing an empty array) means the type is allowed everywhere.

#### Transactions & Batches in Subgraphs

```typescript
const sub = g.subgraph(agentId, 'memories');

// Transaction
await sub.runTransaction(async (tx) => {
  const node = await tx.getNode(memId);
  await tx.putNode('memory', memId, { text: 'updated' });
});

// Batch
const batch = sub.batch();
await batch.putNode('memory', generateId(), { text: 'first' });
await batch.putNode('memory', generateId(), { text: 'second' });
await batch.commit();
```

#### Cascade Delete

`removeNodeCascade` recursively deletes subcollections by default:

```typescript
// Deletes the agent node, all its edges, and all subgraph data
await g.removeNodeCascade(agentId);

// To preserve subgraph data:
await g.removeNodeCascade(agentId, { deleteSubcollections: false });
```

#### Firestore Path Layout

```
graph/                          ← root collection
  {agentId}                     ← agent node document
  {agentId}/memories/           ← subgraph subcollection
    {memId}                     ← memory node document
    {shard:aUid:rel:bUid}       ← edge document
  {agentId}/workspace/          ← another subgraph
    {taskId}                    ← task node document
    {taskId}/subtasks/          ← nested subgraph
      {subtaskId}               ← subtask node document
```

### Cross-Graph Edges

Edges that connect nodes across different subgraphs. The key rule: **edges live with the target node**. A cross-graph edge is stored in the same collection as its target (bUid), while the source (aUid) may be a parent node in an ancestor graph.

```typescript
import { createGraphClient, createRegistry, createTraversal, generateId } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';

// Registry declares that 'assignedTo' edges live in the 'workflow' subgraph
const registry = createRegistry([
  { aType: 'task', axbType: 'is', bType: 'task', jsonSchema: taskSchema },
  { aType: 'agent', axbType: 'is', bType: 'agent', jsonSchema: agentSchema },
  { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
]);

const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// Create a task in the root graph
const taskId = generateId();
await g.putNode('task', taskId, { title: 'Build API' });

// Create agents in a workflow subgraph under the task
const workflow = g.subgraph(taskId, 'workflow');
const agentId = generateId();
await workflow.putNode('agent', agentId, { name: 'Backend Dev' });

// Create the cross-graph edge in the workflow subgraph
// The edge lives alongside the target (agent), source (task) is an ancestor
await workflow.putEdge('task', taskId, 'assignedTo', 'agent', agentId, { role: 'lead' });

// Forward traversal: task → agents (automatically crosses into workflow subgraph)
const result = await createTraversal(g, taskId, registry).follow('assignedTo').run();
// result.nodes contains the agent edges from the workflow subgraph
```

#### How It Works

1. **Writing**: You explicitly call `putEdge` on the subgraph client where the target node lives. The caller decides where the edge goes.

2. **Reverse traversal is free**: Since the edge lives with the target, querying from the agent's perspective (`findEdges({ bUid: agentId })` on the workflow client) finds it locally.

3. **Forward traversal uses `targetGraph`**: When traversing from the task, the engine sees `targetGraph: 'workflow'` on the registry entry and queries `g.subgraph(taskId, 'workflow')` automatically.

4. **Path-scanning resolution**: To determine if an edge's `aUid` is an ancestor node, firegraph parses the Firestore collection path. The path `graph/taskId/workflow` reveals that `taskId` is a document in the `graph` collection.

#### Registry `targetGraph`

The `targetGraph` field on a `RegistryEntry` tells forward traversal which subgraph to query under each source node:

```typescript
createRegistry([
  // When traversing forward from a task along 'assignedTo',
  // look in the 'workflow' subgraph under each task
  { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
]);
```

`targetGraph` must be a single segment (no `/`). It can also be set in entity discovery via `edge.json`:

```json
{ "from": "task", "to": "agent", "targetGraph": "workflow" }
```

#### Explicit Hop Override

You can override the registry's `targetGraph` on a per-hop basis:

```typescript
// Use 'team' subgraph instead of registry's default
const result = await createTraversal(g, taskId).follow('assignedTo', { targetGraph: 'team' }).run();
```

Resolution priority: explicit hop `targetGraph` > registry `targetGraph` > no cross-graph.

#### `findEdgesGlobal` — Collection Group Queries

For cross-cutting reads across all subgraphs, use `findEdgesGlobal`:

```typescript
// Find all 'assignedTo' edges across all 'workflow' subgraphs in the database
const allAssignments = await g.findEdgesGlobal(
  { axbType: 'assignedTo', allowCollectionScan: true },
  'workflow', // collection name to query across
);
```

This uses Firestore collection group queries and requires collection group indexes. The collection name defaults to the last segment of the client's collection path if omitted.

#### Multi-Hop Limitation

Each hop carries its reader context forward — if hop 1 crosses into a subgraph, hop 2 stays in that subgraph. To return to the root or traverse a different subgraph, create a separate traversal from the desired client:

```typescript
// This traversal finds agents in the workflow subgraph
const agents = await createTraversal(g, taskId, registry).follow('assignedTo').run();

// To continue traversing within the workflow subgraph,
// create a new traversal from the subgraph client
const workflow = g.subgraph(taskId, 'workflow');
for (const agent of agents.nodes) {
  const mentees = await createTraversal(workflow, agent.bUid).follow('mentors').run();
}
```

#### Firestore Path Layout

```
graph/                              <- root collection
  {taskId}                          <- task node
  {taskId}/workflow/                <- workflow subgraph
    {agentId}                       <- agent node
    {shard:taskId:assignedTo:agentId} <- cross-graph edge
```

### ID Generation

```typescript
import { generateId } from 'firegraph';

const id = generateId(); // 21-char URL-safe nanoid
```

## Error Handling

All errors extend `FiregraphError` with a `code` property:

| Error Class                    | Code                        | When                                                                    |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| `FiregraphError`               | varies                      | Base class                                                              |
| `NodeNotFoundError`            | `NODE_NOT_FOUND`            | Node lookup fails (not thrown by `getNode` — it returns `null`)         |
| `EdgeNotFoundError`            | `EDGE_NOT_FOUND`            | Edge lookup fails (not thrown by `getEdge` — it returns `null`)         |
| `ValidationError`              | `VALIDATION_ERROR`          | Schema validation fails (registry JSON Schema validation)               |
| `RegistryViolationError`       | `REGISTRY_VIOLATION`        | Triple not registered                                                   |
| `RegistryScopeError`           | `REGISTRY_SCOPE`            | Type not allowed at this subgraph scope                                 |
| `MigrationError`               | `MIGRATION_ERROR`           | Migration function fails or chain is incomplete                         |
| `DynamicRegistryError`         | `DYNAMIC_REGISTRY_ERROR`    | Dynamic registry misconfiguration or misuse                             |
| `InvalidQueryError`            | `INVALID_QUERY`             | `findEdges` called with no filters                                      |
| `QuerySafetyError`             | `QUERY_SAFETY`              | Query would cause a full collection scan                                |
| `TraversalError`               | `TRAVERSAL_ERROR`           | `run()` called with zero hops                                           |
| `CapabilityNotSupportedError`  | `CAPABILITY_NOT_SUPPORTED`  | Capability-gated method called on a backend that doesn't declare it     |
| `CrossBackendTransactionError` | `CROSS_BACKEND_TRANSACTION` | `runTransaction()` attempted across backends with different storage     |
| `DiscoveryError`               | `DISCOVERY_ERROR`           | Entity discovery fails (missing required files, malformed schema, etc.) |

```typescript
import { FiregraphError, ValidationError } from 'firegraph';

try {
  await g.putNode('tour', generateId(), { name: 123 });
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.code); // 'VALIDATION_ERROR'
    console.error(err.details); // OutputUnit[] from @cfworker/json-schema
  }
}
```

## Types

All types are exported for use in your own code:

```typescript
import type {
  // Data models
  GraphRecord,
  StoredGraphRecord,

  // Query
  FindEdgesParams,
  FindNodesParams,
  QueryPlan,
  QueryFilter,
  QueryOptions,
  QueryMode,
  ScanProtection,
  WhereClause,
  IndexFieldSpec,
  IndexSpec,

  // Client interfaces — CoreGraphClient is the unconditional base
  Capability,
  CoreGraphClient,
  GraphReader,
  GraphWriter,
  GraphClient, // generic GraphClient<C extends Capability>
  GraphTransaction,
  GraphBatch,
  GraphClientOptions,

  // Capability-gated extensions
  AggregateExtension,
  AggregateField,
  AggregateOp,
  AggregateResult,
  AggregateSpec,
  SelectExtension,
  FindEdgesProjectedParams,
  ProjectedRow,
  JoinExtension,
  ExpandParams,
  ExpandResult,
  DmlExtension,
  BulkUpdatePatch,
  BulkOptions,
  BulkResult,
  BulkBatchError,
  BulkProgress,
  VectorExtension,
  FindNearestParams,
  DistanceMeasure,
  FullTextSearchExtension,
  GeoExtension,
  RawFirestoreExtension,
  RawSqlExtension,
  RealtimeListenExtension,

  // Registry
  RegistryEntry, // includes targetGraph, allowedIn
  GraphRegistry, // includes lookupByAxbType
  EdgeTopology, // includes targetGraph

  // Dynamic Registry
  DynamicGraphClient,
  DynamicGraphMethods,
  DynamicRegistryConfig,
  NodeTypeData,
  EdgeTypeData,
  DefineTypeOptions,
  CascadeResult,

  // Migration
  MigrationFn,
  MigrationStep,
  StoredMigrationStep,
  MigrationExecutor,
  MigrationWriteBack,
  MigrationResult,

  // Traversal
  HopDefinition, // includes targetGraph
  TraversalOptions,
  HopResult,
  TraversalResult,
  TraversalBuilder,

  // Entity Discovery
  DiscoveredEntity,
  DiscoverResult, // return type of discoverEntities()
  DiscoveryResult, // { nodes: Map<...>, edges: Map<...> } — the .result field of DiscoverResult
  DiscoveryWarning,
} from 'firegraph';
```

> **Note:** Several types are defined in the library but not yet exported from the `'firegraph'` entry point: the parameter and result types for `fullTextSearch()`, `geoSearch()`, and `runEngineTraversal()` (`FullTextSearchParams`, `GeoSearchParams`, `GeoPointLiteral`, `EngineHopSpec`, `EngineTraversalParams`, `EngineTraversalResult`), and the extension interface `EngineTraversalExtension`. Rely on type inference or declare local `Parameters<typeof client.fullTextSearch>[0]`-style helpers until these types are promoted to the public export.

## How It Works

### Storage Layout

All data lives in one Firestore collection. Each document has these fields:

| Field       | Type      | Description                                                                                 |
| ----------- | --------- | ------------------------------------------------------------------------------------------- |
| `aType`     | string    | Source node type                                                                            |
| `aUid`      | string    | Source node ID                                                                              |
| `axbType`   | string    | Relationship type (`is` for nodes)                                                          |
| `bType`     | string    | Target node type                                                                            |
| `bUid`      | string    | Target node ID                                                                              |
| `data`      | object    | User payload                                                                                |
| `v`         | number?   | Schema version (derived from `max(toVersion)` of migrations; set when entry has migrations) |
| `createdAt` | Timestamp | Server-set on create                                                                        |
| `updatedAt` | Timestamp | Server-set on create/update                                                                 |

### Query Planning

When you call `findEdges`, the query planner decides the strategy:

1. **Direct get** — If `aUid`, `axbType`, and `bUid` are all provided, the edge document ID can be computed directly. This is a single-document read (fastest).
2. **Filtered query** — Otherwise, a Firestore query is built from whichever fields are provided, with optional `limit` and `orderBy` applied server-side.

### Traversal Execution

Traversal dispatches through three tiers in order:

1. **Engine-level** (Firestore Enterprise, `traversal.serverSide`): collapses the entire hop chain into one nested-Pipeline server-side round trip. Requires every hop to have a positive `limitPerSource`, no JS `filter` predicates, no cross-graph hops, and depth ≤ 5. Counts as `totalReads: 1`. Controlled by `engineTraversal` option (`'auto'` by default).

2. **Expand fast-path** (`query.join`): one `expand()` call per hop instead of one `findEdges` per source. Counts as 1 read per hop regardless of source-set size.

3. **Per-source loop** (all backends): fan-out over source UIDs in parallel (bounded by semaphore). Each `findEdges` call counts as 1 read against the budget.

For each hop the traversal also: resolves `targetGraph` (hop override → registry → none), creates subgraph readers for cross-graph hops, applies in-memory `filter` + `limit`, deduplicates next source UIDs, and stops with `truncated = true` if the budget is exceeded.

## Query Modes

Firegraph ships two Firestore backends that you choose at construction time:

```typescript
import { createGraphClient } from 'firegraph';
import { createFirestoreStandardBackend } from 'firegraph/firestore-standard';
import { createFirestoreEnterpriseBackend } from 'firegraph/firestore-enterprise';

// Standard — works on any Firestore project, uses classic .where().get() queries
const backend = createFirestoreStandardBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// Enterprise — uses Firestore Pipelines by default; requires Enterprise Firestore
const backend = createFirestoreEnterpriseBackend(db, 'graph');
const g = createGraphClient(backend, { registry });

// Enterprise with classic query path (e.g. to avoid full-collection scans)
const backend = createFirestoreEnterpriseBackend(db, 'graph', { defaultQueryMode: 'classic' });
```

### Standard Backend (`firegraph/firestore-standard`)

Uses classic Firestore queries (`.where().get()`). Works on any Firestore project (no Enterprise edition required). Limitations:

| `data.*` Filters              | Risk                              |
| ----------------------------- | --------------------------------- |
| Fails without composite index | Query errors for unindexed fields |

Appropriate for:

- Any Firestore project (Standard or Enterprise edition)
- **Emulator** testing — classic queries work out of the box
- Projects that manage their own composite indexes

### Enterprise Backend (`firegraph/firestore-enterprise`)

Uses the Firestore Pipeline API (`db.pipeline()`) by default. Requires **Firestore Enterprise** edition.

- Enables queries on `data.*` fields without composite indexes
- Unlocks additional capabilities: `query.dml`, `traversal.serverSide`, `search.fullText`, `search.geo`

**Emulator auto-fallback:** when `FIRESTORE_EMULATOR_HOST` is detected, the Enterprise backend automatically switches to the classic query path (pipelines aren't supported in the emulator). No configuration needed.

**Transactions** always use the classic query path regardless of `defaultQueryMode`, because Pipeline queries are not transactionally bound.

### SQLite Backend (`firegraph/sqlite`)

Shared-table SQLite backend for Node.js (`better-sqlite3`) and Cloudflare D1. Supports all four core capabilities plus `query.aggregate`, `query.select`, `query.join`, and `query.dml`. Does not support `search.*`.

```typescript
import { createSqliteBackend } from 'firegraph/sqlite';
import { createGraphClientFromBackend } from 'firegraph';

const backend = createSqliteBackend(executor, 'graph');
const g = createGraphClientFromBackend(backend, { registry });
```

Note: `core.transactions` is only declared when `executor.transaction` is defined — `better-sqlite3` provides this, but Cloudflare D1 does not.

### Cloudflare Durable Object Backend (`firegraph/cloudflare`)

Runs inside a Durable Object via `state.storage.sql`. Same capability set as SQLite minus `core.transactions` (the DO's single-threaded executor cannot block on transaction callbacks) and `raw.sql` (the DO SQL surface is hidden behind RPC).

```typescript
// In your DO class file (workerd bundle):
import { FiregraphDO } from 'firegraph/cloudflare';
export class MyGraphDO extends FiregraphDO {}

// In your backend code (Node):
import { DORPCBackend, createDOClient } from 'firegraph/cloudflare';
const g = createDOClient(env.MY_GRAPH, 'graph', { registry });
```

`firegraph/cloudflare` also re-exports `createRegistry`, `createMergedRegistry`, `generateId`, `META_NODE_TYPE`, `META_EDGE_TYPE`, and `deleteField()` so workerd-bundled code can build registries without statically importing `@google-cloud/firestore`.

`createSiblingClient(client, siblingRootKey)` creates a peer root-level `DOGraphClient` for a sibling collection within the same Durable Object — useful when a DO hosts multiple logical graph roots.

### Routing Backend (`firegraph/backend`)

Assembles a single capability-typed backend that routes operations to the appropriate per-subgraph backend. Use when different subgraphs live in different storage systems.

```typescript
import { createRoutingBackend } from 'firegraph/backend';
import { createGraphClientFromBackend } from 'firegraph';

const backend = createRoutingBackend(defaultBackend, {
  'users/*': userBackend,
});
const g = createGraphClientFromBackend(backend, { registry });
```

`firegraph/backend` also exports `StorageBackend`, `BackendCapabilities`, `createCapabilities`, and `intersectCapabilities` for authors implementing custom backends.

### Config File

Set the default backend in `firegraph.config.ts`:

```typescript
export default defineConfig({
  entities: './entities',
  queryMode: 'pipeline', // 'pipeline' selects Enterprise, 'standard' selects Standard
});
```

Or via CLI flag: `npx firegraph editor --query-mode pipeline`

## Development

```bash
pnpm build          # Build ESM + CJS + types
pnpm typecheck      # Type check
pnpm test:unit      # Unit tests (no emulator needed)
pnpm test:emulator  # Full test suite against Firestore emulator
```

Requires Node.js 18+.

## License

MIT
