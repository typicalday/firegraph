# Cloudflare Backend

The Cloudflare subsystem (`src/cloudflare/**`) provides a Durable Object backend with per-subgraph isolation. The DO runs inside workerd; the rest of firegraph runs in Node + Firestore. Two runtime constraints make this folder non-obvious: the workerd module resolver, and the workers-types type-surface.

## Runtime: `cloudflare:workers` is virtual

`import { DurableObject } from 'cloudflare:workers'` is a **virtual module** — only the workerd runtime resolves it. Node and bundlers do not. We route the import through a Vitest alias to a stub class (`tests/__shims__/cloudflare-workers.ts`) so unit tests that instantiate `FiregraphDO` directly still work.

`FiregraphDO` **must** `extends DurableObject` (not just match the shape). Plain classes with the same surface fail with `does not support RPC` once they cross an `env.GRAPH.get(id)` stub boundary, because workerd's RPC dispatcher gates on the base class. The integration test in `tests/integration/cloudflare-rpc.test.ts` boots a real workerd via Miniflare and asserts both the positive case (a `FiregraphDO` stub dispatches) and the negative control (a plain class throws the canonical RPC error). If you refactor and CI fails on that test, do not adjust the assertion — the regression is real.

## Type surface: do not use `compilerOptions.types: ["@cloudflare/workers-types"]`

This is a **known performance footgun**. `@cloudflare/workers-types/index.d.ts` is a 479KB file of pure ambient declarations (`declare class`, `declare module`). When listed in `compilerOptions.types`, tsc loads all 479KB of declarations into every source file's lookup scope on every compile. On this codebase that turned `pnpm typecheck` from sub-second into **8 minutes** — diagnosed via `tsc --extendedDiagnostics`.

Cloudflare's [own docs](https://blog.cloudflare.com/improving-workers-types/) call this out. They ship two type-surface variants:

| Variant                                            | Shape                             | When to use                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/workers-types` (root, 479KB)          | Pure ambient (`declare class`)    | Only via a triple-slash directive scoped to a single file. **Never** via `compilerOptions.types`.                                                                                                                                                                                                        |
| `@cloudflare/workers-types/experimental` (subpath) | Module exports (`export declare`) | Per-file `import type { X } from '@cloudflare/workers-types/experimental'`. Module-scoped, no global pollution. Caveat: the `declare module "cloudflare:workers"` block inside this file is treated as a local augmentation (the file is a module), so it does NOT make `cloudflare:workers` resolvable. |

### Current setup (do not regress)

`src/cloudflare/do.ts` is the only file that needs workers-types globals. It uses a triple-slash reference:

```ts
/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';
```

That single directive makes the ambient `cloudflare:workers` module declaration globally visible AND brings types like `DurableObjectState` into scope. The cost is bounded to one file's compile; other source files don't pay it.

### If you need workers-types in another file

1. **First, do you actually need it?** Most consumers can use `unknown` or local `interface`s for env/state shapes. `src/cloudflare/backend.ts` deliberately avoids workers-types — see the comment around line 63.
2. **If yes:** prefer `import type { X } from '@cloudflare/workers-types/experimental'`. It's module-scoped — no impact on other files.
3. **Only add a triple-slash reference** when you need a runtime virtual module (`cloudflare:workers`, `cloudflare:sockets`, etc.) to resolve, since the experimental subpath's `declare module` blocks don't propagate.
4. **Do NOT** add `@cloudflare/workers-types` back to `compilerOptions.types`. If you find yourself wanting to, you have N+1 files using it; consider whether a project-local types file (`src/cloudflare/types.d.ts`) declaring just the surface you use would serve better.

## SQLite version floor: 3.35 (`DELETE … RETURNING` / `UPDATE … RETURNING`)

Both the shared-table SQLite backend (`src/sqlite/backend.ts`) and the DO backend (`src/cloudflare/do.ts`) lean on `RETURNING "doc_id"` to surface authoritative affected-row counts for `updateDoc`, `bulkDelete`, and `bulkUpdate`. SQLite added DML `RETURNING` in 3.35 (March 2021). All three runtimes we ship against — `better-sqlite3`, Cloudflare D1, and DO `state.storage.sql` — are well past that floor, so the dependency is documented but not version-gated at runtime. If you ever see `near "RETURNING": syntax error` from a third-party SQLite executor someone is wiring into the SQLite backend, that's the cause.

## Key files

| File                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cloudflare/do.ts`                     | `FiregraphDO` — the Durable Object class consumers extend or instantiate                                                                                                                                                                                                                                                                                                                         |
| `src/cloudflare/backend.ts`                | `DORPCBackend` — backend implementation that dispatches into the DO                                                                                                                                                                                                                                                                                                                              |
| `src/cloudflare/sql.ts`                    | SQLite DDL/DML for the DO's `state.storage.sql` interface. Implements the 0.12 deep-merge / replace / `deleteField()` write contract via the same `flattenPatch` / `DataPathOp` pipeline as shared SQLite (`src/internal/write-plan.ts`); merge-mode `compileDOSet` uses `COALESCE(excluded."v", "v")` to match Firestore's "undefined leaves the stored field alone" semantic for `v`.          |
| `src/cloudflare/schema.ts`                 | Schema bootstrap inside the DO                                                                                                                                                                                                                                                                                                                                                                   |
| `src/cloudflare/index.ts`                  | Public barrel for `firegraph/cloudflare`. Exports `FiregraphDO`, `DORPCBackend`, `createDOClient`, plus re-exports of `createRegistry`, `createMergedRegistry`, `generateId`, `META_NODE_TYPE`, `META_EDGE_TYPE`, and `deleteField()` so workerd-bundled callers can build registries and write deletes without statically importing the root `firegraph` entry (which would pull in Firestore). |
| `src/internal/serialization-tag.ts`        | Workers-safe `SERIALIZATION_TAG` + `isTaggedValue`, split out specifically so `firegraph/cloudflare` can recognise tagged Firestore-type payloads (Timestamp, GeoPoint, etc.) without statically importing `@google-cloud/firestore`. Same bundle-pollution / module-resolver hygiene as the workers-types and `cloudflare:workers` rules above.                                                 |
| `src/internal/sqlite-payload-guard.ts`     | `assertJsonSafePayload` — the eager INVALID_ARGUMENT guard used by `compileDOSet` and `compileDOUpdate` (replaceData) to reject Firestore special types, non-Date class instances, and stray `DELETE_FIELD` symbols at the write boundary. Shared with the shared-table SQLite backend; failure shape is identical across both.                                                                  |
| `tests/__shims__/cloudflare-workers.ts`    | Vitest alias target for the `cloudflare:workers` virtual module                                                                                                                                                                                                                                                                                                                                  |
| `tests/integration/cloudflare-rpc.test.ts` | Miniflare-driven RPC dispatch test (positive + negative control)                                                                                                                                                                                                                                                                                                                                 |
| `tests/fixtures/cloudflare-rpc/worker.ts`  | Test fixture worker, bundled into the Miniflare run                                                                                                                                                                                                                                                                                                                                              |
