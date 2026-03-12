---
paths:
  - "src/**/*.ts"
---

# Core Library Patterns

## Query Planning

`buildEdgeQueryPlan` checks if all three identifying fields (`aUid`, `axbType`, `bUid`) are present. If so, it returns a `get` strategy (single doc lookup). Otherwise, it builds Firestore `where` filters from whichever fields are provided.

## Adapter Pattern

Three adapters (`FirestoreAdapter`, `TransactionAdapter`, `BatchAdapter`) provide the same interface over different Firestore execution contexts. The client/transaction/batch classes delegate to these adapters.

## Dual-Mode Query Engine

`GraphClientImpl` supports two query backends controlled by `queryMode` in `GraphClientOptions`:

- **`'pipeline'`** (default) -- Uses `PipelineQueryAdapter` from `src/internal/pipeline-adapter.ts`. Translates `QueryFilter[]` to Firestore Pipeline expressions (`Pipelines.equal()`, `Pipelines.greaterThan()`, etc.) and executes via `db.pipeline().collection().where().execute()`. Requires Enterprise Firestore. The `Pipelines` module is lazily loaded via dynamic `import()`.
- **`'standard'`** -- Uses `FirestoreAdapter.query()` which builds standard `.where().get()` queries. Risky for production: Enterprise Firestore does full collection scans for `data.*` filters; Standard Firestore fails without composite indexes.

**Query execution flow:**
1. `findEdges(params)` / `findNodes(params)` -> `buildEdgeQueryPlan()` / `buildNodeQueryPlan()`
2. If GET strategy (all 3 identifiers present) -> `adapter.getDoc()` (bypasses query mode)
3. If QUERY strategy -> `executeQuery(filters, options)` -> dispatches to either `pipelineAdapter.query()` or `adapter.query()` based on `queryMode`

**Key rules:**
- Pipeline is the default. Users must explicitly opt into standard mode.
- Emulator auto-fallback: `FIRESTORE_EMULATOR_HOST` set -> always standard (emulator doesn't support pipelines).
- Transactions always use standard queries (`TransactionAdapter`) regardless of `queryMode` -- Pipeline is not transactionally bound.
- Writes and doc lookups are always standard -- pipeline adapter only handles the `query()` path.
- A one-time `console.warn` fires when standard mode is explicitly set outside the emulator.

## Traversal

`createTraversal(reader, startUid, registry?)` returns a builder. `.follow(axbType, opts)` adds hops. `.run(opts)` executes sequentially hop-by-hop, with parallel fan-out within each hop controlled by a semaphore. Budget (`maxReads`) is checked before each Firestore call.

**Cross-graph traversal:** When `reader` is a `GraphClient` and a hop has `targetGraph` (explicit or from registry), the traversal creates a subgraph reader via `reader.subgraph(sourceUid, targetGraph)` for that hop. Plain `GraphReader` readers silently fall back to local queries.

**targetGraph resolution priority:** hop definition > registry (`lookupByAxbType`) > none.
