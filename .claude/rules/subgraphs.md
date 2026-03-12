---
paths:
  - "src/scope.ts"
  - "src/client.ts"
  - "src/bulk.ts"
  - "tests/**/subgraph*"
  - "tests/**/scope*"
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

## Key Constraints

- Subgraph name must not contain `/` (throws `FiregraphError` with code `INVALID_SUBGRAPH`)
- `parentNodeUid` must be non-empty and must not contain `/`
- Subgraph clients share a snapshot of the parent's registry -- if `reloadRegistry()` is called on a `DynamicGraphClient`, existing subgraph clients do NOT see updated types
- `subgraph()` always returns `GraphClient` (not `DynamicGraphClient`) -- no `defineNodeType`/`defineEdgeType` on subgraph clients
- Traversals on a subgraph client are scoped to that subgraph only
