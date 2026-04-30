---
paths:
  - 'src/firestore-standard/**/*.ts'
  - 'src/firestore-enterprise/**/*.ts'
  - 'src/sqlite/**/*.ts'
  - 'src/cloudflare/**/*.ts'
  - 'src/internal/backend.ts'
  - 'src/internal/routing-backend.ts'
  - 'src/internal/firestore-*.ts'
  - 'src/internal/sqlite-*.ts'
---

# Backends & Capabilities

The backend layer is split into per-edition modules. Each backend implements `StorageBackend` (`src/internal/backend.ts`) and exposes a phantom-typed `BackendCapabilities<C>` descriptor. The `C` parameter is a union of `Capability` literals that drives the conditional types in `GraphClient<C>` so methods only appear on the surface when the backend declares them.

The full design is `.claude/plans/backend-capabilities-plan.md`. This file is the day-to-day reference.

## Capability matrix

Source of truth: the `*_CAPS` literal sets in each backend file (`src/firestore-standard/backend.ts`, `src/firestore-enterprise/backend.ts`, `src/sqlite/backend.ts`, `src/cloudflare/backend.ts`) and the assertions in `tests/unit/capabilities.test.ts`. The table below mirrors them exactly:

| Capability          | firestore-standard                                       | firestore-enterprise                                                        | sqlite (better-sqlite3)                                | sqlite (D1)                            | cloudflare-do                                     |
| ------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------- |
| `core.read`         | ✓                                                        | ✓                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `core.write`        | ✓                                                        | ✓                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `core.transactions` | ✓                                                        | ✓                                                                           | ✓ (`executor.transaction` exists)                      | — (D1 has no sync transaction surface) | — (would block the DO's single-threaded executor) |
| `core.batch`        | ✓                                                        | ✓                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `core.subgraph`     | ✓                                                        | ✓                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `query.aggregate`   | ✓ (count/sum/avg; min/max throw `UNSUPPORTED_AGGREGATE`) | ✓ (same as Standard today; pipeline-based min/max is a future optimisation) | ✓ (full count/sum/avg/min/max via `CAST(... AS REAL)`) | ✓                                      | ✓                                                 |
| `query.select`      | ✓                                                        | ✓                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `query.join`        | —                                                        | —                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `query.dml`         | —                                                        | —                                                                           | ✓                                                      | ✓                                      | ✓                                                 |
| `search.vector`     | ✓                                                        | ✓                                                                           | —                                                      | —                                      | —                                                 |
| `search.fullText`   | — (Enterprise feature; never available on Standard)      | — (typed-API gap; see below)                                                | —                                                      | —                                      | —                                                 |
| `search.geo`        | — (Enterprise feature; never available on Standard)      | — (typed-API gap; see below)                                                | —                                                      | —                                      | —                                                 |
| `realtime.listen`   | —                                                        | —                                                                           | —                                                      | —                                      | —                                                 |
| `raw.firestore`     | ✓                                                        | ✓                                                                           | —                                                      | —                                      | —                                                 |
| `raw.sql`           | —                                                        | —                                                                           | ✓                                                      | ✓                                      | —                                                 |

**`query.aggregate` sub-shape:** there is no separate sub-capability for the `min`/`max` subset. Both Firestore editions declare exactly `'query.aggregate'`; the runtime helper rejects `min`/`max` with `UNSUPPORTED_AGGREGATE`. SQLite and DO declare the same literal but accept the full set. Callers that depend on `min`/`max` should branch on the backend identifier, not on the capability flag.

**`search.fullText` and `search.geo` framing:**

- **Firestore Standard** does not support full-text search or geospatial queries at all. They are Enterprise-only product features. The "—" in this row will never become "✓".
- **Firestore Enterprise** supports both in production, but `@google-cloud/firestore@8.3.0` does not expose typed `Pipeline.search()` / geo-distance methods. The typed `Pipeline` surface is `addFields, aggregate, distinct, execute, findNearest, limit, offset, rawStage, removeFields, replaceWith, sample, select, sort, stream, union, unnest, where`. Reaching FTS / geo today requires the `rawStage(...)` escape hatch against a real Enterprise project. We have not declared the capabilities because doing so without a runtime path would break the routing invariant ("declared capability ⇒ method exists"). The type-level scaffolding (`FullTextSearchExtension`, `GeoExtension`, `FullTextSearchParams`, `GeoSearchParams` in `src/types.ts`) is in place so the API contract is committed and wiring is additive when the SDK exposes typed stages or we commit to a `rawStage(...)`-based implementation gated behind `FIREGRAPH_ENTERPRISE=1`.
- **SQLite / DO** never get these — they have no native FTS or geo index, and emulating either over `json_extract` is not viable for any realistic dataset.

## Routing invariant

`createRoutingBackend` (`src/internal/routing-backend.ts`) enforces "declared capability ⇒ method exists" both directions:

- A backend that declares a capability MUST implement the corresponding method, or the routing wrapper throws at construction.
- A backend that implements an extension method but does NOT declare the matching capability is still callable through the routing wrapper, but the type-level surface won't expose it — keep the two in sync.

`tests/unit/routing-backend.test.ts` pins both directions. If you add a new capability, update both `Capability` (in `src/types.ts`) and the matrix above.

## Editing rules

- **Adding a method to the type surface only.** Add the extension interface in `src/types.ts`. Do NOT declare the capability on any backend until a runtime path exists; declared-but-unimplemented capabilities turn the type gate into a runtime lie. See `FullTextSearchExtension` / `GeoExtension` for the pattern.
- **Adding a method to one backend.** Implement on the backend, declare the capability in its `BackendCapabilities` constant, and run `pnpm test:unit` — the routing-backend invariant tests will catch any drift.
- **Sharing across Firestore editions.** Standard and Enterprise both delegate to helpers under `src/internal/firestore-*.ts`. Add the shared validation / path-normalisation logic there; backends should be thin wiring.
- **Sharing across SQLite editions.** Shared SQLite (`src/sqlite/`) and Cloudflare DO (`src/cloudflare/`) both compile through helpers under `src/internal/sqlite-*.ts`. The DO edition has its own SQL compiler in `src/cloudflare/sql.ts` because it uses `state.storage.sql` rather than `better-sqlite3`, but both go through `assertJsonSafePayload` (`src/internal/sqlite-payload-guard.ts`) for the JSON-safe payload guard at the write boundary.

## Edition-specific notes

- **firestore-enterprise:** Has its own `defaultQueryMode: 'pipeline' | 'classic'` toggle for the query path. Pipelines are the default; classic is forced when `FIRESTORE_EMULATOR_HOST` is set. A one-time `console.warn` fires if classic is forced in production. Transactions, writes, and doc lookups always use classic. See `core-library.md` "Firestore Edition Internals."
- **firestore-standard:** Classic-only. No pipeline path, no emulator-fallback warning.
- **sqlite / cloudflare-do:** Both rely on SQLite 3.35+ for `DELETE … RETURNING` / `UPDATE … RETURNING` (used to return authoritative affected-row counts). All three target runtimes — `better-sqlite3`, Cloudflare D1, DO `state.storage.sql` — are well past that floor. See `cloudflare.md` for the workers-types and `cloudflare:workers` virtual-module rules.
