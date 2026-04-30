---
paths:
  - 'src/**/*.ts'
---

# Core Library Patterns

## Capability-Gated Backends

Every backend implements `StorageBackend` from `src/internal/backend.ts` and exposes a phantom-typed `BackendCapabilities<C>` descriptor. `GraphClient<C>` is conditionally typed against `C`, so methods like `aggregate`, `findNearest`, `select`, `bulkDelete`, `bulkUpdate`, `joinFindEdges` only appear on the surface when the backend's `C` literal includes the matching capability. Routing (`src/internal/routing-backend.ts`) enforces "declared capability ⇒ method exists" both directions: a backend that declares a capability MUST implement it, and a backend that implements it MUST declare it. Tests in `tests/unit/capabilities.test.ts` and `tests/unit/routing-backend.test.ts` pin this invariant.

The four shipped backends declare exactly:

| Capability                                                  | firestore-standard                                 | firestore-enterprise                                                             | sqlite                                                          | cloudflare-do                                     |
| ----------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `core.read` / `core.write` / `core.batch` / `core.subgraph` | ✓                                                  | ✓                                                                                | ✓                                                               | ✓                                                 |
| `core.transactions`                                         | ✓                                                  | ✓                                                                                | ✓ if `executor.transaction` defined (`better-sqlite3`); — on D1 | — (would block the DO's single-threaded executor) |
| `query.aggregate`                                           | ✓                                                  | ✓                                                                                | ✓                                                               | ✓                                                 |
| `query.select`                                              | ✓                                                  | ✓                                                                                | ✓                                                               | ✓                                                 |
| `query.join`                                                | ✓ (chunked classic `'in'`, ≤30 per chunk)          | ✓ (Pipelines `equalAny`)                                                         | ✓                                                               | ✓                                                 |
| `query.dml` (bulk)                                          | —                                                  | ✓ when `previewDml: true` (Pipelines `delete()` / `update()` — `@beta` in 8.5.0) | ✓                                                               | ✓                                                 |
| `traversal.serverSide`                                      | —                                                  | ✓ (nested Pipelines `define` + `addFields(child.toArrayExpression())`)           | —                                                               | —                                                 |
| `search.vector`                                             | ✓                                                  | ✓                                                                                | —                                                               | —                                                 |
| `search.fullText`                                           | — (Enterprise-only product feature; never on Std.) | ✓ (Pipelines `search()`)                                                         | —                                                               | —                                                 |
| `search.geo`                                                | — (Enterprise-only product feature; never on Std.) | ✓ (Pipelines `search()`)                                                         | —                                                               | —                                                 |
| `realtime.listen`                                           | —                                                  | —                                                                                | —                                                               | —                                                 |
| `raw.firestore`                                             | ✓                                                  | ✓                                                                                | —                                                               | —                                                 |
| `raw.sql`                                                   | —                                                  | —                                                                                | ✓                                                               | —                                                 |

Standard intentionally rejects `query.aggregate` `min`/`max` at runtime (Standard SDK doesn't expose them) — both Firestore editions declare exactly `'query.aggregate'`; there is no separate sub-capability for the min/max subset. SQLite and DO support the full count/sum/avg/min/max set natively via SQL.

**Firestore-edition FTS / geo wiring:** Firestore Enterprise supports full-text search and geospatial queries in production. As of `@google-cloud/firestore@8.5.0`, the typed Pipelines surface exposes `Pipeline.search({ query, sort?, addFields? })`, `documentMatches(query)`, `geoDistance(field, point)`, `score()`, and `BooleanExpression` / `Ordering` — enough to wire both without falling back to `rawStage(...)`. The Enterprise backend declares `search.fullText` and `search.geo` and delegates to shared helpers `src/internal/firestore-fulltext.ts` and `src/internal/firestore-geo.ts`. Constraint: the `search()` stage **must be the first stage** of a pipeline, so identifying filters (`aType` / `axbType` / `bType`) land in a follow-up `.where(...)` stage rather than the search query expression. The geo radius cap stays inside `search.query` (where the geo index applies it efficiently); ascending-distance sort goes in `search.sort` when `orderByDistance !== false` (the default). Migrations are not applied to FTS / geo results — the search index walked the raw stored shape, and rehydrating through the migration pipeline would change the candidate set the index already scored. Per-field FTS predicates (`matches(field, query)`) are not yet typed in 8.5.0; the helper validates a supplied `fields` list but executes document-wide `documentMatches(query)` until the SDK exposes the typed predicate. Firestore Standard never gets these capabilities — they are Enterprise-only product features.

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

**Engine-level traversal (`traversal.serverSide`, Phase 13c):** When the reader's backend declares `traversal.serverSide` (Firestore Enterprise only), the traversal layer can collapse the entire hop sequence into a single nested-Pipeline server-side call instead of fanning out one round trip per hop. Opt in via `engineTraversal: 'auto' | 'force' | 'off'` on `TraversalOptions` (default `'auto'`). The compiler (`src/internal/firestore-traverse-compiler.ts`) checks eligibility — depth ≤ `MAX_PIPELINE_DEPTH` (5), every hop has a positive `limitPerSource`, and worst-case response size (`sources.length × Π(limitPerSource_i)`) fits inside `maxReads`. Per-hop blockers in the traversal layer: a JS `filter` predicate (server-side execution can't run JS) or a forward hop with `targetGraph` set (cross-graph hops reach a different routed backend). On any blocker `'auto'` mode silently falls back to the per-hop loop; `'force'` mode throws `UNSUPPORTED_OPERATION`. Engine traversal always dispatches through Pipelines regardless of the Enterprise edition's `defaultQueryMode` — join-key binding via `define` / `variable` has no classic Query API equivalent. One server-side round trip is billed as `totalReads: 1` (mirrors the `expand()` fast-path accounting). The decoder strips `hop_{depth}_children` scaffolding and applies the NODE_RELATION self-loop guard for parity with `expand()`.
