---
paths:
  - 'src/backend.ts'
  - 'src/scope-path.ts'
  - 'src/internal/routing-backend.ts'
  - 'tests/**/routing-backend*'
  - 'tests/**/scope-path*'
  - 'tests/**/backend-surface*'
---

# Routing Backend

## Purpose

`createRoutingBackend(base, { route })` is firegraph's primitive for splitting a logical graph across multiple physical storage backends. The canonical use case is staying under Cloudflare Durable Object's 10 GB per-DO cap by fanning specific subgraph names out to their own DOs — but the primitive knows nothing about DOs, RPC, or naming. It only composes `StorageBackend`s.

## Where it lives

Public entry point: `firegraph/backend`. The full surface is intentionally small:

- `StorageBackend`, `TransactionBackend`, `BatchBackend`, `WritableRecord`, `UpdatePayload` (types, promoted from `internal/backend.ts`)
- `createRoutingBackend(base, options)`, `RoutingContext`, `RoutingBackendOptions`
- `parseStorageScope`, `resolveAncestorScope`, `isAncestorScopeUid`, `appendStorageScope`, `StorageScopeSegment`
- `CrossBackendTransactionError`

## Two scope vocabularies

Firegraph has always tracked two shapes of the subgraph chain. `routing.md` locks the vocabulary in so the rest of the codebase (and external docs) use the same names:

| Name           | Shape                                          | Example                  | Consumed by                                 |
| -------------- | ---------------------------------------------- | ------------------------ | ------------------------------------------- |
| `scopePath`    | names-only                                     | `'memories/context'`     | `allowedIn` matching (`matchScope`)         |
| `storageScope` | materialized: interleaved `<uid>/<name>` pairs | `'A/memories/B/context'` | SQLite `scope` column, DO names, shard keys |

Both are `/`-delimited strings. `scopePath` is empty at the root; `storageScope` is empty at the root. `subgraphs.md` describes the former. Storage-scope is owned by the SQLite backend (`SqliteBackendImpl`) and is now also the canonical form used by the routing primitive.

## Contract summary

The routing backend's contract is intentionally tight. Every rule below is anchored by a unit test in `tests/unit/routing-backend.test.ts`.

### 1. Nested routing is always active

Every child returned by `subgraph()` is re-wrapped by the same router, regardless of whether `route()` returned a routed backend or `null` (pass-through to the base). That way `router.subgraph(A, 'memories').subgraph(B, 'context')` consults `route()` on **both** hops. Forgetting this self-wrap would silently bypass the router on grandchildren — the tests `'continues routing on grandchildren of a routed child'` and `'keeps routing in effect for grandchildren after a pass-through'` guard against that regression.

The wrapper also tracks the logical `scopePath` independently of the wrapped backend's own `.scopePath`. A freshly-minted per-DO backend returned from `route()` typically reports `scopePath: ''` (it has no knowledge of the caller's logical chain); the wrapper carries the logical view forward so grandchildren still see the correct `scopePath` in their `RoutingContext`.

### 2. `route()` is synchronous

`.subgraph()` is synchronous in firegraph's public API, so `route()` must be too. Consequence: `route` can only consult data it already has in hand (DO bindings, naming rules, in-memory caches). "Does this DO exist?" checks belong in the backend's own ops — the first read against the returned backend surfaces failure naturally.

### 3. Transactions and batches never span routed backends

`runTransaction(fn)` and `createBatch()` on a routing backend delegate entirely to the **base** backend. This is enforced structurally: `TransactionBackend` and `BatchBackend` don't expose `subgraph()`, so well-typed code physically cannot open a routed child inside a transaction callback.

The guarantee firegraph provides: _a transaction started on a routed backend commits atomically against that backend only_. There is no silent cross-backend mode.

`CrossBackendTransactionError` (public code `CROSS_BACKEND_TRANSACTION`) is exported as a future-proofing type: app code can catch it if a later interface change ever surfaces a cross-backend-atomicity violation at runtime. Today it is unreachable through well-typed code — it exists as a stable public shape, not as a guard the router currently throws. See its docstring in `src/errors.ts`.

### 4. `findEdgesGlobal` is base-scope only

`findEdgesGlobal` on a routing backend runs against the **base** backend only. It does **not** fan out to routed children — firegraph has no enumeration index for which routed backends exist. This is documented behaviour, not an error; callers using `findEdgesGlobal` inside a single DO for local analytics continue to work. Apps needing cross-shard collection-group queries must maintain their own scope directory.

### 5. Cascade delete is base-scope only

`removeNodeCascade` on a routing backend cascades only within the base backend. If a node has routed subgraphs under it, the caller must enumerate and cascade them explicitly. Same rationale as `findEdgesGlobal`: firegraph doesn't own the live-scope directory.

## `RoutingContext` fields

Every `route()` invocation receives:

```ts
{
  parentUid: string; // the first arg to subgraph()
  subgraphName: string; // the second arg to subgraph()
  scopePath: string; // logical, names-only: 'memories/context'
  storageScope: string; // materialized, interleaved: 'A/memories/B/context'
}
```

Use `storageScope` when you want a globally unique, human-readable identifier (DO name, shard key) — two different parent UIDs under the same subgraph name produce distinct storage-scopes. Use `scopePath` when your routing rule depends only on the subgraph name chain (e.g. "all `memories` subgraphs go to the memory DO namespace").

## Example — routing `memories` subgraphs to a separate backend

```ts
import { createGraphClientFromBackend } from 'firegraph';
import { createRoutingBackend } from 'firegraph/backend';

// `base` is any StorageBackend — e.g. a Firestore-backed one, an
// in-process SQLite backend, or a DO-backed backend constructed elsewhere.
const routed = createRoutingBackend(base, {
  route: ({ subgraphName, storageScope }) => {
    if (subgraphName !== 'memories') return null;
    // Return any StorageBackend keyed by `storageScope`. Typical choices:
    // a dedicated DO stub wrapped as a backend, a second Firestore
    // collection, or a separate in-process SQLite database.
    return createMyMemoriesBackend(storageScope);
  },
});

const client = createGraphClientFromBackend(routed, { registry });
```

`createMyMemoriesBackend` is caller-owned: firegraph only knows about the
`StorageBackend` interface, not about any particular physical target.

## What firegraph explicitly does not ship

- No live-scope directory. Persistence choice (D1? KV? registry DO?) is app-specific.
- No cross-backend cascade. Callers enumerate routed children themselves.
- No async `route()`. The cost of async-ifying `.subgraph()` exceeds the benefit.

## Key files

| File                                 | Purpose                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/backend.ts`                     | Public `firegraph/backend` entry point — re-exports the routing primitive, scope-path helpers, backend types, and `CrossBackendTransactionError` |
| `src/internal/routing-backend.ts`    | `RoutingStorageBackend` implementation; module doc is the canonical contract reference                                                           |
| `src/scope-path.ts`                  | `parseStorageScope`, `resolveAncestorScope`, `isAncestorScopeUid`, `appendStorageScope`                                                          |
| `src/errors.ts`                      | `CrossBackendTransactionError` (code `CROSS_BACKEND_TRANSACTION`)                                                                                |
| `tests/unit/routing-backend.test.ts` | Full contract coverage — nested routing, pass-through delegation, input validation                                                               |
| `tests/unit/scope-path.test.ts`      | Storage-scope parsing round-trips                                                                                                                |
| `tests/unit/backend-surface.test.ts` | Compile-time shape lock + runtime export manifest for `firegraph/backend`                                                                        |
