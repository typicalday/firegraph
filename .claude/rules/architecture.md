# Architecture

## Graph Model

Every record in Firestore is a **triple**: `(aType, aUid) -[axbType]-> (bType, bUid)`.

- **Nodes** are stored as self-loops: `(tour, Kj7vNq2mP9xR4wL1tY8s3) -[is]-> (tour, Kj7vNq2mP9xR4wL1tY8s3)`. The special relation `is` (constant `NODE_RELATION`) marks a record as a node.
- **Edges** are standard directed edges: `(tour, Kj7vNq2mP9xR4wL1tY8s3) -[hasDeparture]-> (departure, Xp4nTk8qW2vR7mL9jY5a1)`.

UIDs **must** be generated via `generateId()` (21-char nanoid). Short human-readable strings like `tour1` will create Firestore hotspots because lexicographically similar IDs concentrate writes on the same storage nodes.

All records in a graph live in one Firestore collection (subgraphs use nested subcollections — see `subgraphs.md`). Document IDs:
- Nodes: the UID itself (e.g., `Kj7vNq2mP9xR4wL1tY8s3`)
- Edges: `shard:aUid:axbType:bUid` where shard is first hex char of SHA-256 hash (16-bucket distribution to avoid hotspots)

## Key Modules

| File | Purpose |
|------|---------|
| `src/client.ts` | `GraphClientImpl` -- main entry point implementing `GraphClient` |
| `src/transaction.ts` | `GraphTransactionImpl` -- read/write inside Firestore transactions |
| `src/batch.ts` | `GraphBatchImpl` -- atomic batch writes |
| `src/query.ts` | Query planner: routes `FindEdgesParams` to either `get` (direct doc lookup) or `query` (filtered scan) strategy |
| `src/traverse.ts` | Multi-hop graph traversal with budget enforcement, concurrency control, and cross-graph hops |
| `src/cross-graph.ts` | Path-scanning resolution for cross-graph edge references (`resolveAncestorCollection`, `isAncestorUid`) |
| `src/registry.ts` | Optional schema registry for type-safe edge validation (JSON Schema via ajv) |
| `src/dynamic-registry.ts` | Dynamic registry: bootstrap schemas, `createRegistryFromGraph()`, deterministic UIDs |
| `src/json-schema.ts` | JSON Schema validation (ajv) and introspection (JSON Schema -> `FieldMeta[]`) |
| `src/discover.ts` | Convention-based entity auto-discovery from per-entity folders |
| `src/codegen/index.ts` | TypeScript type generation from JSON Schema (uses `json-schema-to-typescript`) |
| `src/config.ts` | `defineConfig()`, `resolveView()` -- project config file types and view resolution |
| `src/views.ts` | `defineViews()` -- framework-agnostic model view definitions (Web Components) |
| `src/react.ts` | `wrapReact()` -- React adapter for firegraph views (`firegraph/react`) |
| `src/svelte.ts` | `wrapSvelte()` -- Svelte 5 adapter for firegraph views (`firegraph/svelte`) |
| `src/scope.ts` | Scope pattern matching (`matchScope`, `matchScopeAny`) for `allowedIn` constraints |
| `src/record.ts` | Builds `GraphRecord` objects with server timestamps |
| `src/docid.ts` | Computes document IDs (passthrough for nodes, sharded hash for edges) |
| `src/id.ts` | 21-char nanoid generation |
| `src/errors.ts` | Error hierarchy: `FiregraphError` base with typed subclasses |
| `src/types.ts` | All TypeScript interfaces and types |
| `src/internal/firestore-adapter.ts` | Low-level Firestore operations (standard, transaction, batch adapters) |
| `src/internal/pipeline-adapter.ts` | Pipeline query adapter -- translates `QueryFilter[]` to Pipeline expressions |
| `src/internal/constants.ts` | `NODE_RELATION = 'is'`, shard config |

## Interfaces

- `GraphReader` -- read operations (`getNode`, `getEdge`, `edgeExists`, `findEdges`, `findNodes`)
- `GraphWriter` -- write operations (`putNode`, `putEdge`, `updateNode`, `removeNode`, `removeEdge`)
- `GraphClient` -- extends both + `runTransaction()` + `batch()` + `subgraph()`
- `DynamicGraphClient` -- extends `GraphClient` + `defineNodeType()` + `defineEdgeType()` + `reloadRegistry()` (returned when `registryMode` is set)
- `GraphTransaction` -- extends both (used inside `runTransaction`)
- `GraphBatch` -- extends `GraphWriter` + `commit()`

Both `GraphClient` and `GraphTransaction` implement `GraphReader`, so `createTraversal()` accepts either.

## Schema Validation

Registry validation uses JSON Schema (via ajv). Each `RegistryEntry` has an optional `jsonSchema` field:

```typescript
createRegistry([
  { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
  { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema, inverseLabel: 'departureOf' },
]);
```

Alternatively, pass a `DiscoveryResult` directly:
```typescript
const { result } = discoverEntities('./entities');
const registry = createRegistry(result);
```

## Inverse Labels

Edge entries support an optional `inverseLabel` field -- a display-only label for when an edge is viewed from the B-side (incoming direction). This does not create a real inverse edge; it's purely cosmetic for the editor UI.

The label flows through: `RegistryEntry.inverseLabel` -> `introspectRegistry()` -> `GET /api/schema` -> frontend `EdgeType.inverseLabel` -> `NodeDetail.tsx` + `DrillBreadcrumb.tsx`.
