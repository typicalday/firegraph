---
paths:
  - "src/scope.ts"
  - "src/client.ts"
  - "src/bulk.ts"
  - "src/cross-graph.ts"
  - "src/traverse.ts"
  - "tests/**/subgraph*"
  - "tests/**/scope*"
  - "tests/**/cross-graph*"
---

# Subgraphs

## How Subgraphs Work

`GraphClient.subgraph(parentNodeUid, name?)` returns a new `GraphClient` scoped to a Firestore subcollection at `{collectionPath}/{parentNodeUid}/{name}`. Default name is `'graph'`.

Each subgraph client has a `scopePath` (chain of subgraph names, e.g. `workspace/subtasks`). Root clients have `scopePath = ''`.

## Scope Path Construction

```
Root client:       scopePath = ''
g.subgraph(A, 'memories'):   scopePath = 'memories'
sub.subgraph(B, 'context'):  scopePath = 'memories/context'
```

## allowedIn Patterns

Registry entries support `allowedIn?: string[]` to constrain where types can exist. Matching is done by `matchScope(scopePath, pattern)` in `src/scope.ts`.

| Pattern | Matches scope path |
|---------|--------------------|
| `root` | `''` (root graph only) |
| `agents` | Exactly `'agents'` |
| `agents/memories` | Exactly `'agents/memories'` |
| `*/agents` | `*` matches one segment: `'foo/agents'` |
| `**/memories` | `**` matches zero or more: `'memories'`, `'a/memories'`, `'a/b/memories'` |
| `**` | Everything including root |

Empty/undefined `allowedIn` means allowed everywhere (backwards compatible).

## Validation Flow

1. `putNode`/`putEdge` in client, transaction, or batch calls `registry.validate(aType, axbType, bType, data, scopePath)`
2. If `scopePath !== undefined` and `entry.allowedIn` is non-empty, `matchScopeAny(scopePath, allowedIn)` is called
3. Mismatch throws `RegistryScopeError`

## Cascade Delete

`removeNodeCascade` in `src/bulk.ts` recurses into subcollections via `deleteSubcollectionsRecursive`:
- Uses `docRef.listCollections()` to discover subcollections
- Depth-first recursion: delete nested subcollections before parent
- `onProgress` is NOT propagated to subcollection deletes (prevents misleading progress)
- Errors from subcollection deletes are accumulated in `CascadeResult.errors`
- `deleteSubcollections: false` in `BulkOptions` skips subcollection cleanup

## Cross-Graph Edges

Cross-graph edges connect nodes across different subgraphs. The key rule: **edges live with the target node**. A cross-graph edge's document is stored in the same collection as its bUid (target), while its aUid (source) may be an ancestor node whose UID appears in the Firestore collection path.

### Path-Scanning Resolution

`resolveAncestorCollection(collectionPath, uid)` in `src/cross-graph.ts` parses the Firestore path's rigid `collection/doc/collection/doc` structure. If a UID appears at an odd index (document segment), it returns the collection containing that document.

```typescript
resolveAncestorCollection('graph/A/workspace/B/context', 'A')
// → 'graph'

resolveAncestorCollection('graph/A/workspace/B/context', 'B')
// → 'graph/A/workspace'
```

`isAncestorUid(collectionPath, uid)` is a boolean shorthand.

### Registry `targetGraph`

Edge `RegistryEntry` objects support `targetGraph?: string` — a single-segment subgraph name. This tells forward traversal where to look for edges that live in a subgraph.

```typescript
createRegistry([
  { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
]);
```

`targetGraph` must not contain `/` (validated at registry construction time).

### Forward Traversal

`createTraversal(reader, startUid, registry?)` accepts `GraphClient | GraphReader`. Cross-graph hops only work when a `GraphClient` is provided (needs the `subgraph()` method).

Resolution priority for each hop:
1. Explicit `hop.targetGraph` (user override on `.follow()`)
2. Registry `targetGraph` for the `axbType` (via `lookupByAxbType`)
3. `undefined` (no cross-graph — query locally)

When crossing graphs, the traversal calls `reader.subgraph(sourceUid, targetGraph)` to create a subgraph reader for that hop.

**Context tracking:** Once a hop crosses into a subgraph, subsequent hops without `targetGraph` stay in that subgraph automatically (the reader is carried forward). If a later hop has an explicit `targetGraph`, it creates a new subgraph reader relative to the root client. To return to the root graph mid-traversal, create a separate traversal from the root client.

**Non-GraphClient warning:** When the reader is a plain `GraphReader` and a hop resolves `targetGraph`, a one-time `console.warn` is emitted. The traversal still executes (queries locally) but the warning helps catch configuration mistakes.

### `findEdgesGlobal()`

`GraphClient.findEdgesGlobal(params, collectionName?)` uses `db.collectionGroup(name)` to query edges across all subgraphs. Defaults the collection name to the last segment of the client's collection path.

- Requires Firestore collection group indexes
- Cannot use GET strategy (all three identifiers) — throws `FiregraphError`
- Subject to scan protection settings

### `lookupByAxbType()`

`GraphRegistry.lookupByAxbType(axbType)` returns all entries matching a given edge relation name. Used internally by traversal for `targetGraph` resolution. Returns a frozen `ReadonlyArray`.

### Key Files

| File | Purpose |
|------|---------|
| `src/cross-graph.ts` | Path-scanning resolution utilities |
| `src/traverse.ts` | Cross-graph traversal (accepts `GraphClient \| GraphReader`) |
| `src/registry.ts` | `lookupByAxbType`, `targetGraph` propagation, validation |
| `tests/unit/cross-graph.test.ts` | Path resolution unit tests |
| `tests/integration/cross-graph.test.ts` | Cross-graph edge integration tests |

## Key Constraints

- Subgraph name must not contain `/` (throws `FiregraphError` with code `INVALID_SUBGRAPH`)
- `parentNodeUid` must be non-empty and must not contain `/`
- `targetGraph` must be a single segment (no `/`) — validated at registry construction
- Subgraph clients share a snapshot of the parent's registry -- if `reloadRegistry()` is called on a `DynamicGraphClient`, existing subgraph clients do NOT see updated types
- `subgraph()` always returns `GraphClient` (not `DynamicGraphClient`) -- no `defineNodeType`/`defineEdgeType` on subgraph clients
- Traversals on a subgraph client are scoped to that subgraph only
- Cross-graph traversal requires a `GraphClient` reader — plain `GraphReader` falls back to local queries with a one-time warning
