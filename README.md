# Firegraph

A typed graph data layer for Firebase Cloud Firestore. Store nodes and edges in a single collection with smart query planning, sharded document IDs, optional schema validation, and multi-hop traversal.

## Install

```bash
npm install firegraph firebase-admin
# or
pnpm add firegraph firebase-admin
```

Optional schema validation with Zod:

```bash
npm install zod
```

## Quick Start

```typescript
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createGraphClient, generateId } from 'firegraph';

initializeApp();
const db = getFirestore();
const g = createGraphClient(db, 'graph');

// Create nodes
const tourId = generateId();
await g.putNode('tour', tourId, { name: 'Dolomites Classic', difficulty: 'hard' });

const depId = generateId();
await g.putNode('departure', depId, { date: '2025-07-15', maxCapacity: 30 });

// Create an edge
await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 0 });

// Query edges
const departures = await g.findEdges({ aUid: tourId, abType: 'hasDeparture' });
```

## Core Concepts

### Graph Model

Firegraph stores everything as **triples** in a single Firestore collection:

```
(aType, aUid) -[abType]-> (bType, bUid)
```

- **Nodes** are self-referencing edges with the special relation `is`:
  `(tour, tour1) -[is]-> (tour, tour1)`
- **Edges** are directed relationships between nodes:
  `(tour, tour1) -[hasDeparture]-> (departure, dep1)`

Every record carries a `data` payload (arbitrary JSON), plus `createdAt` and `updatedAt` server timestamps.

### Document IDs

- **Nodes**: The UID itself (e.g., `tour1`)
- **Edges**: `shard:aUid:abType:bUid` where the shard prefix (0–f) is derived from SHA-256, distributing writes across 16 buckets to avoid Firestore hotspots

## API Reference

### Creating a Client

```typescript
import { createGraphClient } from 'firegraph';

const g = createGraphClient(db, 'graph');
// or with options:
const g = createGraphClient(db, 'graph', { registry });
```

**Parameters:**
- `db` — A `firestore.Firestore` instance from firebase-admin
- `collectionPath` — Firestore collection path for all graph data
- `options.registry` — Optional `GraphRegistry` for schema validation

### Nodes

```typescript
// Create or overwrite a node
await g.putNode('tour', 'tour1', { name: 'Dolomites Classic' });

// Read a node
const node = await g.getNode('tour1');
// → StoredGraphRecord | null

// Update fields (merge)
await g.updateNode('tour1', { 'data.difficulty': 'extreme' });

// Delete a node
await g.removeNode('tour1');

// Find all nodes of a type
const tours = await g.findNodes({ aType: 'tour' });
```

### Edges

```typescript
// Create or overwrite an edge
await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });

// Read a specific edge
const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
// → StoredGraphRecord | null

// Check existence
const exists = await g.edgeExists('tour1', 'hasDeparture', 'dep1');

// Delete an edge
await g.removeEdge('tour1', 'hasDeparture', 'dep1');
```

### Querying Edges

`findEdges` accepts any combination of filters. When all three identifiers (`aUid`, `abType`, `bUid`) are provided, it uses a direct document lookup instead of a query scan.

```typescript
// Forward: all departures of a tour
await g.findEdges({ aUid: 'tour1', abType: 'hasDeparture' });

// Reverse: all tours that have this departure
await g.findEdges({ abType: 'hasDeparture', bUid: 'dep1' });

// Type-scoped: all hasDeparture edges from any tour
await g.findEdges({ aType: 'tour', abType: 'hasDeparture' });

// With limit and ordering
await g.findEdges({
  aUid: 'tour1',
  abType: 'hasDeparture',
  limit: 5,
  orderBy: { field: 'data.order', direction: 'asc' },
});
```

### Transactions

Full read-write transactions with automatic retry:

```typescript
await g.runTransaction(async (tx) => {
  const dep = await tx.getNode('dep1');
  const count = (dep?.data.registeredRiders as number) || 0;

  if (count < 30) {
    await tx.putEdge('departure', 'dep1', 'hasRider', 'rider', riderId, {});
    await tx.updateNode('dep1', { 'data.registeredRiders': count + 1 });
  }
});
```

The transaction object (`tx`) has the same read/write methods as the client. Writes are synchronous within the transaction and committed atomically.

### Batches

Atomic batch writes (no reads):

```typescript
const batch = g.batch();
await batch.putNode('rider', 'r1', { name: 'Alice' });
await batch.putNode('rider', 'r2', { name: 'Bob' });
await batch.putEdge('rider', 'r1', 'friends', 'rider', 'r2', {});
await batch.commit();
```

### Graph Traversal

Multi-hop traversal with budget enforcement, concurrency control, and in-memory filtering:

```typescript
import { createTraversal } from 'firegraph';

// Tour → Departures → Riders (2 hops)
const result = await createTraversal(g, 'tour1')
  .follow('hasDeparture', { limit: 5, bType: 'departure' })
  .follow('hasRider', {
    limit: 20,
    filter: (edge) => edge.data.status === 'confirmed',
  })
  .run({ maxReads: 200, returnIntermediates: true });

result.nodes;      // StoredGraphRecord[] — edges from the final hop
result.hops;       // HopResult[] — per-hop breakdown
result.totalReads; // number — Firestore reads consumed
result.truncated;  // boolean — true if budget was hit
```

#### Reverse Traversal

Walk edges backwards to find parents:

```typescript
// Rider → Departures → Tours
const result = await createTraversal(g, 'rider1')
  .follow('hasRider', { direction: 'reverse' })
  .follow('hasDeparture', { direction: 'reverse' })
  .run();

// result.nodes contains the tour edges
```

#### Traversal in Transactions

```typescript
await g.runTransaction(async (tx) => {
  const result = await createTraversal(tx, 'tour1')
    .follow('hasDeparture')
    .follow('hasRider')
    .run();
  // Use result to make transactional writes...
});
```

#### Hop Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `direction` | `'forward' \| 'reverse'` | `'forward'` | Edge direction |
| `aType` | `string` | — | Filter source node type |
| `bType` | `string` | — | Filter target node type |
| `limit` | `number` | `10` | Max edges per source node |
| `orderBy` | `{ field, direction? }` | — | Firestore-level ordering |
| `filter` | `(edge) => boolean` | — | In-memory post-filter |

#### Run Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxReads` | `number` | `100` | Total Firestore read budget |
| `concurrency` | `number` | `5` | Max parallel queries per hop |
| `returnIntermediates` | `boolean` | `false` | Include edges from all hops |

When `filter` is set, the `limit` is applied after filtering (in-memory), so Firestore returns all matching edges and the filter + slice happens client-side.

### Schema Registry

Optional type validation using Zod (or any object with a `.parse()` method):

```typescript
import { createRegistry, createGraphClient } from 'firegraph';
import { z } from 'zod';

const registry = createRegistry([
  {
    aType: 'tour',
    abType: 'is',
    bType: 'tour',
    dataSchema: z.object({
      name: z.string(),
      difficulty: z.enum(['easy', 'medium', 'hard']),
    }),
  },
  {
    aType: 'tour',
    abType: 'hasDeparture',
    bType: 'departure',
    // No dataSchema = any data allowed for this edge type
  },
]);

const g = createGraphClient(db, 'graph', { registry });

// This validates against the registry before writing:
await g.putNode('tour', 'tour1', { name: 'Alps', difficulty: 'hard' }); // OK
await g.putNode('tour', 'tour1', { name: 123 }); // throws ValidationError

// Unregistered triples are rejected:
await g.putEdge('tour', 't1', 'unknownRel', 'x', 'x1', {}); // throws RegistryViolationError
```

### ID Generation

```typescript
import { generateId } from 'firegraph';

const id = generateId(); // 21-char URL-safe nanoid
```

## Error Handling

All errors extend `FiregraphError` with a `code` property:

| Error Class | Code | When |
|------------|------|------|
| `FiregraphError` | varies | Base class |
| `NodeNotFoundError` | `NODE_NOT_FOUND` | Node lookup fails (not thrown by `getNode` — it returns `null`) |
| `EdgeNotFoundError` | `EDGE_NOT_FOUND` | Edge lookup fails |
| `ValidationError` | `VALIDATION_ERROR` | Schema validation fails (registry + Zod) |
| `RegistryViolationError` | `REGISTRY_VIOLATION` | Triple not registered |
| `InvalidQueryError` | `INVALID_QUERY` | `findEdges` called with no filters |
| `TraversalError` | `TRAVERSAL_ERROR` | `run()` called with zero hops |

```typescript
import { FiregraphError, ValidationError } from 'firegraph';

try {
  await g.putNode('tour', 'tour1', { name: 123 });
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.code);    // 'VALIDATION_ERROR'
    console.error(err.details); // Zod error details
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

  // Client interfaces
  GraphReader,
  GraphWriter,
  GraphClient,
  GraphTransaction,
  GraphBatch,
  GraphClientOptions,

  // Registry
  RegistryEntry,
  GraphRegistry,

  // Traversal
  HopDefinition,
  TraversalOptions,
  HopResult,
  TraversalResult,
  TraversalBuilder,
} from 'firegraph';
```

## How It Works

### Storage Layout

All data lives in one Firestore collection. Each document has these fields:

| Field | Type | Description |
|-------|------|-------------|
| `aType` | string | Source node type |
| `aUid` | string | Source node ID |
| `abType` | string | Relationship type (`is` for nodes) |
| `bType` | string | Target node type |
| `bUid` | string | Target node ID |
| `data` | object | User payload |
| `createdAt` | Timestamp | Server-set on create |
| `updatedAt` | Timestamp | Server-set on create/update |

### Query Planning

When you call `findEdges`, the query planner decides the strategy:

1. **Direct get** — If `aUid`, `abType`, and `bUid` are all provided, the edge document ID can be computed directly. This is a single-document read (fastest).
2. **Filtered query** — Otherwise, a Firestore query is built from whichever fields are provided, with optional `limit` and `orderBy` applied server-side.

### Traversal Execution

1. Start with `sourceUids = [startUid]`
2. For each hop in sequence:
   - Fan out: query edges for each source UID (parallel, bounded by semaphore)
   - Each `findEdges` call counts as 1 read against the budget
   - Apply in-memory `filter` if specified, then apply `limit`
   - Collect edges, extract next source UIDs (deduplicated)
   - If budget exceeded, mark `truncated` and stop
3. Return final hop edges as `nodes`, all hop data in `hops`

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
