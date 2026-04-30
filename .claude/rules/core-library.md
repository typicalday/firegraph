---
paths:
  - 'src/**/*.ts'
---

# Core Library Patterns

## Capability-Gated Backends

Every backend implements `StorageBackend` from `src/internal/backend.ts` and exposes a phantom-typed `BackendCapabilities<C>` descriptor. `GraphClient<C>` is conditionally typed against `C`, so methods like `aggregate`, `findNearest`, `select`, `bulkDelete`, `bulkUpdate`, `joinFindEdges` only appear on the surface when the backend's `C` literal includes the matching capability. Routing (`src/internal/routing-backend.ts`) enforces "declared capability ⇒ method exists" both directions: a backend that declares a capability MUST implement it, and a backend that implements it MUST declare it. Tests in `tests/unit/capabilities.test.ts` and `tests/unit/routing-backend.test.ts` pin this invariant.

The four shipped backends declare exactly:

| Capability                                                  | firestore-standard                                  | firestore-enterprise          | sqlite                                                          | cloudflare-do                                     |
| ----------------------------------------------------------- | --------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `core.read` / `core.write` / `core.batch` / `core.subgraph` | ✓                                                   | ✓                             | ✓                                                               | ✓                                                 |
| `core.transactions`                                         | ✓                                                   | ✓                             | ✓ if `executor.transaction` defined (`better-sqlite3`); — on D1 | — (would block the DO's single-threaded executor) |
| `query.aggregate`                                           | ✓                                                   | ✓                             | ✓                                                               | ✓                                                 |
| `query.select`                                              | ✓                                                   | ✓                             | ✓                                                               | ✓                                                 |
| `query.join`                                                | —                                                   | —                             | ✓                                                               | ✓                                                 |
| `query.dml` (bulk)                                          | —                                                   | —                             | ✓                                                               | ✓                                                 |
| `search.vector`                                             | ✓                                                   | ✓                             | —                                                               | —                                                 |
| `search.fullText`                                           | — (Enterprise feature; never available on Standard) | — (typed-API gap — see below) | —                                                               | —                                                 |
| `search.geo`                                                | — (Enterprise feature; never available on Standard) | — (typed-API gap — see below) | —                                                               | —                                                 |
| `realtime.listen`                                           | —                                                   | —                             | —                                                               | —                                                 |
| `raw.firestore`                                             | ✓                                                   | ✓                             | —                                                               | —                                                 |
| `raw.sql`                                                   | —                                                   | —                             | ✓                                                               | —                                                 |

Standard intentionally rejects `query.aggregate` `min`/`max` at runtime (Standard SDK doesn't expose them) — both Firestore editions declare exactly `'query.aggregate'`; there is no separate sub-capability for the min/max subset. SQLite and DO support the full count/sum/avg/min/max set natively via SQL.

**Why Firestore-edition FTS / geo show "—" but stay on the type surface:** Firestore Enterprise _does_ support full-text search and geospatial queries in production, but `@google-cloud/firestore@8.3.0` does not expose typed `Pipeline.search()` / geo-distance methods on its `Pipeline` class. The typed surface is `addFields, aggregate, distinct, execute, findNearest, limit, offset, rawStage, removeFields, replaceWith, sample, select, sort, stream, union, unnest, where`. Reaching FTS / geo today requires the `rawStage(...)` escape hatch against a real Enterprise database — declaring the capability without that wiring would turn the type-level gate into a runtime lie. `FullTextSearchExtension` / `GeoExtension` / `FullTextSearchParams` / `GeoSearchParams` are recorded on the type surface so the contract is committed; wiring lands when the SDK exposes typed stages or when we commit to a `rawStage(...)`-based implementation gated behind `FIREGRAPH_ENTERPRISE=1`. Firestore Standard never gets these capabilities — they are Enterprise-only product features and will never be added to the Standard backend.

## Firestore Edition Internals

Both Firestore editions delegate writes, doc lookups, and transactionally-bound reads to the **classic** SDK adapter (`src/internal/firestore-classic-adapter.ts`). The Enterprise edition adds a `queryMode` toggle (`'pipeline'` | `'classic'`) for the `findEdges` / `findNodes` query path:

- **`'pipeline'`** (default on Enterprise) — Translates `QueryFilter[]` to Firestore Pipeline expressions and executes via `db.pipeline().collection().where().execute()`. Requires Enterprise Firestore. The `Pipelines` module is lazily loaded via dynamic `import()`.
- **`'classic'`** — Uses the classic-adapter `query()` which builds `.where().get()` queries. Risky in production: Enterprise does full collection scans for `data.*` filters without composite indexes.

**Auto-fallback rules (Enterprise edition):**

- `FIRESTORE_EMULATOR_HOST` set → always classic (emulator doesn't support pipelines). One-time `console.warn` fires.
- Transactions → always classic (pipelines aren't transactionally bound).
- Writes / doc lookups → always classic.
- Explicit `'classic'` outside the emulator → one-time `console.warn` (production scan risk).

The Standard edition has no pipeline path; its query layer is classic-only by construction.

## Query Planning

`buildEdgeQueryPlan` checks if all three identifying fields (`aUid`, `axbType`, `bUid`) are present. If so, it returns a `get` strategy (single doc lookup, bypasses any backend's query layer). Otherwise, it builds a filter list passed through to the backend's `query` capability — Firestore translates to `where(...).get()` or pipeline `where(...).execute()` per `queryMode`; SQLite-shape backends translate to a single `SELECT` with `json_extract` on `data.*` paths.

## Traversal

`createTraversal(reader, startUid, registry?)` returns a builder. `.follow(axbType, opts)` adds hops. `.run(opts)` executes sequentially hop-by-hop, with parallel fan-out within each hop controlled by a semaphore. Budget (`maxReads`) is checked before each Firestore call.

**Cross-graph traversal:** When `reader` is a `GraphClient` and a hop has `targetGraph` (explicit or from registry), the traversal creates a subgraph reader via `reader.subgraph(sourceUid, targetGraph)` for that hop. Plain `GraphReader` readers silently fall back to local queries.

**targetGraph resolution priority:** hop definition > registry (`lookupByAxbType`) > none.
