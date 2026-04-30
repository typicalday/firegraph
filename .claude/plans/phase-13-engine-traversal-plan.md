# Build Plan — Phase 13: Engine-Level Traversal on Firestore Enterprise

> **Companion docs:**
>
> - [`./backend-capabilities-plan.md`](./backend-capabilities-plan.md) — original capability refactor (Phases 1–11). Read its "Phase 5" and "Phase 6" sections for context on what was deferred.
> - [`../rules/backends.md`](../rules/backends.md) — current capability matrix (this plan changes three rows).
> - [`../rules/core-library.md`](../rules/core-library.md) — Firestore edition internals, traversal model.
>
> **Precedent:** Phase 12 (`d42fb4c`) backfilled `search.fullText` / `search.geo` on `firestore-enterprise` after the typed Pipelines surface arrived in `@google-cloud/firestore@8.5.0`. Phase 13 follows the same pattern for three more capabilities, plus introduces a new one.

## Why now

The original Phase 5 (`query.dml`) and Phase 6 (`query.join`) shipped on SQLite and Cloudflare DO only. The Enterprise wiring was deferred with this rationale (still in `src/firestore-enterprise/backend.ts`, lines 102–126):

> The Firestore SDK shipped at `@google-cloud/firestore@8.5.0` exposes Pipelines DML adjacents (`update`, `delete` stages on the protobuf surface) but the typed `Pipeline` class still does not surface them …

That assumption is **wrong as of 8.5.0**. Inspection of `node_modules/@google-cloud/firestore/types/firestore.d.ts` shows:

| Capability                                         | d.ts evidence                                                                                 | Status   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------- |
| `query.join` via `equalAny`                        | `equalAny(...)` / `notEqualAny(...)` — typed exports of the Pipelines namespace               | GA-typed |
| `query.dml` via Pipeline `delete()`/`update()`     | `Pipeline.delete()` (line 12647), `Pipeline.update(transformedFields)` (line 12662)           | `@beta`  |
| Server-side correlated subquery (engine traversal) | `Pipeline.define(...)` (12442), `toArrayExpression()` (12507), `toScalarExpression()` (12573) | GA-typed |
| Server-side set ops                                | `Pipeline.union(other)` (12127), `Pipeline.unnest(...)` (13177)                               | GA-typed |

So we can:

1. Backfill `query.join` on **both** Firestore editions (Enterprise via `equalAny`, Standard via classic chunked `in`).
2. Backfill `query.dml` on `firestore-enterprise` via Pipeline `delete()` / `update()` stages, gated behind a preview flag while the stages remain `@beta`.
3. Introduce a **new** capability `traversal.serverSide` that compiles a multi-hop `TraverseSpec` into a single nested pipeline using `define` + `toArrayExpression`, and execute the whole traversal in one round trip on `firestore-enterprise`.

These ladder onto each other: 13c (engine traversal) uses `equalAny` from 13a at its leaves. 13b is independent.

## Goals

1. Eliminate per-source fan-out round trips for traversal hops on Firestore Enterprise (and reduce them on Standard).
2. Bring server-side bulk delete / bulk update parity to Firestore Enterprise — and deliver the cascade-delete speedup that was the original Phase 5 motivation but never reached Firestore.
3. Make N-hop traversal a single Firestore round trip on Enterprise via correlated subqueries.
4. Keep observable behavior identical across all backends for callers that don't need engine-level optimisation.
5. No backwards compatibility breaks — all changes are additive (new capabilities flip "—" to "✓" in the matrix; existing code paths remain valid fallbacks).

## Non-goals (explicit)

- Cross-graph engine traversal (different collection paths can't compose into one pipeline; falls back to per-hop loop, same as Phase 6's cross-graph rule).
- Pipeline DML in transactions (Pipelines aren't transactionally bound — same constraint that already applies to query mode).
- SQLite recursive-CTE-based traversal (the SQLite backend already does single-statement multi-hop via per-hop `compileExpand` + JOIN; an engine-level compiler there is out of scope).
- Cloudflare DO engine traversal (DO already executes everything locally in the isolate; no fan-out problem to solve).
- Promoting Pipeline DML out of preview status — we ship behind a flag and a `console.warn`.

## Success criteria

- `pnpm typecheck` passes with the three matrix flips (`query.join` on both editions, `query.dml` on Enterprise) and one new capability (`traversal.serverSide` on Enterprise).
- `pnpm test:unit` passes. Routing-backend invariant tests pin the new capability declarations against method existence.
- New unit tests cover each helper (mock-Pipeline composition, like Phase 12's `vi.mock('@google-cloud/firestore')` pattern in `tests/unit/firestore-fulltext.test.ts`).
- Capability matrix in `.claude/rules/backends.md` and `.claude/rules/core-library.md` updated.
- The deferred-rationale comment block in `src/firestore-enterprise/backend.ts` (lines 102–126) is **removed and replaced** with a forward-pointing comment describing the new wiring (mirroring how Phase 12 handled the FTS/geo deferral comment).
- `client.expand(...)` and `client.bulkDelete(...)` / `client.bulkUpdate(...)` are TypeScript-callable on a Firestore Enterprise client and produce server-side execution. `client.traverse(...)` (or whatever the new entry point is — see Phase 13c) is callable on Enterprise and produces a single-round-trip result for in-graph hops.
- An `/audit` checkpoint at the end of each sub-phase passes.

## Phase ordering (rationale)

Three sub-phases. Each is independently shippable (separate commits, separate audits). Order is risk-ascending:

- **13a** — `query.join` backfill. Smallest. Largest immediate user payoff for traversal. Sets up `equalAny` plumbing that 13c reuses.
- **13b** — `query.dml` backfill. Independent of 13a. Behind a preview flag because the Pipeline DML stages are `@beta`.
- **13c** — `traversal.serverSide` (new capability + engine traversal compiler). Builds on 13a. Largest scope — needs a TraverseSpec → nested-pipeline compiler, cycle detection, response-size guard.

Each sub-phase ends with an `/audit` per `CLAUDE.md`'s "Post-Change Audits" rule.

---

## Phase 13a — Backfill `query.join` on both Firestore editions

**Goal:** flip the `query.join` row from "—" to "✓" on both `firestore-standard` and `firestore-enterprise`. Internal helper consumed by `traverse.ts`. No new public method (consistent with SQLite/DO, which keep `compileExpand` internal).

### Files

| File                                                | Change                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/firestore-enterprise/backend.ts`               | Add `'query.join'` to `FirestoreEnterpriseCapability` and `ENTERPRISE_CAPS`. Implement `expand(...)` method delegating to a new shared helper. Update the rationale comment block (lines 102–126) to describe the wiring.                                                                                     |
| `src/firestore-standard/backend.ts`                 | Add `'query.join'` to capability set. Implement `expand(...)` via classic chunked `where('aUid', 'in', chunk)` with 30-element batches and parallel `Promise.all`.                                                                                                                                            |
| `src/internal/firestore-expand.ts` (NEW)            | Shared helper: takes `{ collectionPath, aType, axbType, aUids, ... }`, lazily imports `@google-cloud/firestore`, builds `pipeline.collection(...).where(and(equal('aType', T), equal('axbType', E), equalAny('aUid', uids)))`, executes, decodes. Mirrors `firestore-fulltext.ts` / `firestore-geo.ts` shape. |
| `src/internal/firestore-classic-expand.ts` (NEW)    | Standard-edition helper: chunks `aUids` into 30-element groups, fires `Promise.all` of `query()` calls with `'aUid' in chunk` filters, concats results. Reuses `firestore-classic-adapter.ts`'s query method.                                                                                                 |
| `src/internal/routing-backend.ts`                   | Add conditional install for `expand` matching the pattern used for `fullTextSearch` / `geoSearch` in Phase 12.                                                                                                                                                                                                |
| `src/traverse.ts`                                   | Branch on `caps.has('query.join')`. If yes, replace per-source `findEdges` loop at each hop with single `expand()` call. If no, retain existing semaphore loop.                                                                                                                                               |
| `tests/unit/firestore-expand.test.ts` (NEW)         | `vi.mock('@google-cloud/firestore')` pattern. Stubs `equalAny`, `equal`, `and`. Asserts pipeline shape, decode, large-uid-list passes through unchanged (no chunking on Enterprise path).                                                                                                                     |
| `tests/unit/firestore-classic-expand.test.ts` (NEW) | Stubs Firestore `Query.where(...).get()`. Asserts 30-cap chunking, parallel dispatch, result concat.                                                                                                                                                                                                          |
| `tests/unit/capabilities.test.ts`                   | Add assertions: both Firestore editions declare `query.join`, both install `expand` method. Remove `query.join` from negative-control list.                                                                                                                                                                   |

### Helper signature (Enterprise)

```ts
// src/internal/firestore-expand.ts
export interface FirestoreExpandParams {
  aType: string;
  axbType: string;
  aUids: readonly string[];
  bType?: string;
  limitPerSource?: number;
  // future: where? for additional data.* filters
}

export async function runFirestorePipelineExpand(
  db: Firestore,
  collectionPath: string,
  params: FirestoreExpandParams,
): Promise<StoredGraphRecord[]> { … }
```

### Helper signature (Standard, classic)

```ts
// src/internal/firestore-classic-expand.ts
export async function runFirestoreClassicExpand(
  query: ClassicQueryAdapter,
  params: FirestoreExpandParams,
): Promise<StoredGraphRecord[]> { … }
```

### Pipeline shape (Enterprise)

```ts
db.pipeline()
  .collection(collectionPath)
  .where(
    and(
      equal('aType', params.aType),
      equal('axbType', params.axbType),
      equalAny('aUid', [...params.aUids]),
      // bType? added if specified
    ),
  )
  // limit applied client-side (per-source caps don't compose into one pipeline limit)
  .execute();
```

The `equalAny` predicate has no documented small-list cap. Phase 13a includes one emulator-skipped integration test that exercises 1 000 source UIDs to pin behaviour against a real Enterprise instance. If the call rejects, we chunk inside `runFirestorePipelineExpand` and document the cap.

### Standard chunking strategy

Classic Firestore's `where('aUid', 'in', [...])` caps at 30. The helper:

1. Splits `aUids` into ⌈N/30⌉ chunks.
2. Fires `Promise.all` of `query()` calls (already parallel via `firestore-classic-adapter.ts`).
3. Concats results in order.

This is strictly faster than the current per-source loop (which is N parallel calls, not ⌈N/30⌉).

### Rationale comment update

Replace the lines 102–126 block in `firestore-enterprise/backend.ts` with:

```ts
/**
 * `query.join` is wired through `runFirestorePipelineExpand`
 * (`src/internal/firestore-expand.ts`) using the typed
 * `equalAny(field, values)` predicate from
 * `@google-cloud/firestore@8.5.0`. Multi-source fan-out for
 * traversal hops collapses to a single round trip per hop —
 * see `traverse.ts`'s `caps.has('query.join')` branch.
 *
 * `query.dml` is wired through `runFirestorePipelineDml`
 * (`src/internal/firestore-bulk-dml.ts`) using `@beta`
 * `Pipeline.delete()` / `Pipeline.update(transforms)` stages.
 * The capability is declared but the methods emit a one-time
 * `console.warn` until the SDK promotes the stages out of
 * preview — same pattern as the classic-emulator-fallback warning.
 */
```

### Tests

- Unit: 13a adds two new test files (mock-pipeline + chunking).
- Integration (gated, Enterprise-only): `tests/integration/firestore-expand-pipeline.test.ts` with a `LARGE_FANOUT=1` env gate to exercise the equalAny cap. Skipped under emulator (pipelines don't run there — same gate as Phase 12 used for FTS/geo).
- Routing-backend test: assert both directions of the invariant for `query.join` on both Firestore editions.

### Audit

Run `/audit`. Files touched: ~9.

### Exit criteria

- Both Firestore editions declare `query.join` and install `expand`.
- `traverse.ts` uses `expand` on Enterprise; uses chunked `expand` on Standard; falls through to existing loop on backends that don't declare the cap.
- `tests/unit/capabilities.test.ts` updated and passing.
- Cross-graph traversal still falls through to the per-hop loop (same rule as Phase 6, documented in `traverse.ts`).

---

## Phase 13b — Backfill `query.dml` on `firestore-enterprise`

**Goal:** flip `query.dml` from "—" to "✓" on Enterprise via Pipelines `delete()` / `update()` stages. Public surface (`bulkDelete`, `bulkUpdate`) already exists from Phase 5 — Phase 13b just makes it work on Firestore Enterprise instead of falling through to the read-then-write loop.

### Files

| File                                                        | Change                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/firestore-enterprise/backend.ts`                       | Add `'query.dml'` to capability set. Implement `bulkDelete(filters)` and `bulkUpdate(filters, patch)` delegating to a new shared helper. Update rationale comment (already touched in 13a). Add `previewDml?: boolean` option to `FirestoreEnterpriseOptions`; default `false` ⇒ throw `CapabilityNotSupportedError` with a clear message; `true` ⇒ wire and `console.warn` once. |
| `src/internal/firestore-bulk-dml.ts` (NEW)                  | Shared helper: `runFirestorePipelineDelete(db, path, filters)` and `runFirestorePipelineUpdate(db, path, filters, transforms)`. Lazy `import('@google-cloud/firestore')`. Builds `pipeline.collection(path).where(filters).delete()` / `.update([transforms])` and executes. Decodes the affected-row count from the result.                                                      |
| `src/internal/routing-backend.ts`                           | Conditional install for `bulkDelete` / `bulkUpdate` (already present from Phase 5; just verify the Enterprise path now satisfies the invariant).                                                                                                                                                                                                                                  |
| `src/bulk.ts`                                               | No change — already branches on `caps.has('query.dml')` from Phase 5. Cascade-delete on Enterprise will now hit the Pipeline path automatically once the capability flips.                                                                                                                                                                                                        |
| `src/types.ts`                                              | No new types — `BulkUpdatePatch` / `DmlExtension` already exist. Add `previewDml` to `FirestoreEnterpriseOptions` types if not already there.                                                                                                                                                                                                                                     |
| `tests/unit/firestore-bulk-dml.test.ts` (NEW)               | Mock-pipeline tests: assert `delete()` stage appended after `where`, assert `update([…])` shape with `AliasedExpression` arrays, assert preview-flag gating (throw without flag, warn-once with flag).                                                                                                                                                                            |
| `tests/unit/capabilities.test.ts`                           | Add assertions: Enterprise (with `previewDml: true`) declares `query.dml`, installs both methods. Without the flag, capability stays "—".                                                                                                                                                                                                                                         |
| `tests/integration/firestore-bulk-dml.test.ts` (NEW, gated) | Real Enterprise integration: 1 000-edge cascade-delete, time the call, assert wall-clock < N× the read-then-write loop. Gated `LARGE_FANOUT=1`. Skipped under emulator.                                                                                                                                                                                                           |

### Preview-flag pattern

Mirroring how `defaultQueryMode` already toggles classic vs pipeline:

```ts
export interface FirestoreEnterpriseOptions {
  defaultQueryMode?: FirestoreEnterpriseQueryMode;
  /**
   * Opt in to Pipelines DML stages (`@beta` in `@google-cloud/firestore@8.5.0`).
   * When `false` (default), the backend does NOT declare `query.dml` and
   * `bulkDelete` / `bulkUpdate` route through the existing read-then-write
   * fallback. When `true`, the backend declares `query.dml` and dispatches
   * to `Pipeline.delete()` / `Pipeline.update(...)`. A one-time
   * `console.warn` fires explaining the preview status.
   */
  previewDml?: boolean;
  scopePath?: string;
}
```

This keeps the default safe — callers don't accidentally rely on a `@beta` SDK surface — while still typed-callable when opted in.

### Helper signatures

```ts
// src/internal/firestore-bulk-dml.ts
export async function runFirestorePipelineDelete(
  db: Firestore,
  collectionPath: string,
  filters: QueryFilter[],
): Promise<{ deleted: number }> { … }

export async function runFirestorePipelineUpdate(
  db: Firestore,
  collectionPath: string,
  filters: QueryFilter[],
  patch: BulkUpdatePatch,
): Promise<{ updated: number }> { … }
```

The `BulkUpdatePatch` type from Phase 5 is reused unchanged. Internally the helper translates dot-path patches into `AliasedExpression[]` via `field('data.x.y').as('data.x.y')` or `add(...)` etc., depending on the patch op shape.

### Tests

- Unit: vi.mock pattern, like 13a and Phase 12.
- Integration (gated): one test per method, real Enterprise, large-fanout.
- Routing-backend invariant: declared ⇒ installed, with `previewDml: true`.

### Audit

Run `/audit`. Files touched: ~7.

### Exit criteria

- Enterprise with `previewDml: true` declares `query.dml` and dispatches `bulkDelete` / `bulkUpdate` to Pipeline stages.
- Enterprise without the flag keeps the old behaviour (read-then-write fallback in `bulk.ts`).
- One-time `console.warn` fires on first preview-DML call.
- The rationale comment in `firestore-enterprise/backend.ts` reflects the wiring.
- Cascade-delete benchmark (informational): Enterprise + previewDml > N× faster than Standard read-then-write for a 1 000-edge node.

---

## Phase 13c — `traversal.serverSide`: engine-level multi-hop traversal

**Goal:** introduce a new capability and a traversal compiler that turns a multi-hop `TraverseSpec` into a single nested Pipeline using `define` + `variable` + `toArrayExpression`. One round trip for an in-graph N-hop traversal on Enterprise. Bigger than 13a/13b — has its own design considerations.

### New capability

```ts
// src/types.ts
export type Capability =
  | … // existing
  | 'traversal.serverSide';
```

Declared on `firestore-enterprise` only (initially). SQLite/DO already execute traversal locally — no fan-out problem to solve. Standard could in principle compose nested classic queries via `Promise.all`, but that's not a meaningful win over the Phase 13a chunked `expand`.

### Files

| File                                                                | Change                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                                      | Add `'traversal.serverSide'` to `Capability` union. Add `EngineTraversalParams`, `EngineTraversalResult` types. Possibly a new `TraversalExtension` interface following `JoinExtension` / `DmlExtension` shape.                                                                       |
| `src/firestore-enterprise/backend.ts`                               | Declare the capability. Implement `runEngineTraversal(spec)` delegating to a compiler.                                                                                                                                                                                                |
| `src/internal/firestore-traverse.ts` (NEW)                          | The traversal compiler. Takes a normalised `TraverseSpec`, emits a nested `Pipeline` AST, executes, decodes a tree of records.                                                                                                                                                        |
| `src/internal/firestore-traverse-compiler.ts` (NEW)                 | Pure compiler logic: `TraverseSpec → PipelineAST`. Easier to unit-test than the executor.                                                                                                                                                                                             |
| `src/traverse.ts`                                                   | Branch on `caps.has('traversal.serverSide')`. If yes and the spec has no cross-graph hops and is depth-bounded, emit one `runEngineTraversal` call. Otherwise fall back to existing per-hop loop (which itself uses `expand` on backends that declare `query.join`, courtesy of 13a). |
| `src/internal/routing-backend.ts`                                   | Conditional install for the new method.                                                                                                                                                                                                                                               |
| `tests/unit/firestore-traverse-compiler.test.ts` (NEW)              | Unit-test the compiler in isolation: `TraverseSpec → PipelineAST` shape, cycle detection, depth bounds.                                                                                                                                                                               |
| `tests/unit/firestore-traverse.test.ts` (NEW)                       | vi.mock-Pipeline integration of the executor.                                                                                                                                                                                                                                         |
| `tests/integration/firestore-engine-traversal.test.ts` (NEW, gated) | Real Enterprise: 3-hop traversal, 100-element fan-out at hop 1, assert single round trip via SDK spy, assert tree result shape. Gated.                                                                                                                                                |
| `tests/unit/capabilities.test.ts`                                   | Assert Enterprise declares the new cap and installs the method.                                                                                                                                                                                                                       |
| `.claude/rules/backends.md`                                         | Add `traversal.serverSide` row to the matrix.                                                                                                                                                                                                                                         |
| `.claude/rules/core-library.md`                                     | Same. Add a "Server-side multi-hop traversal" subsection describing when the capability triggers.                                                                                                                                                                                     |
| `.claude/rules/architecture.md`                                     | Update the Enterprise edition row to list the new capability.                                                                                                                                                                                                                         |

### Compiled pipeline shape

For a 2-hop spec `(A) -e1-> (B) -e2-> (C)` starting from `aUids`:

```ts
db.pipeline()
  .collection(graph)
  .where(and(equal('aType', 'A'), equal('axbType', 'e1'), equalAny('aUid', aUids)))
  .define(field('bUid').as('hop0_bUid'))
  .addFields(
    db
      .pipeline()
      .collection(graph)
      .where(and(equal('aType', 'B'), equal('axbType', 'e2'), equal('aUid', variable('hop0_bUid'))))
      .select('bUid', 'data', 'aUid', 'axbType', 'bType')
      .toArrayExpression()
      .as('hop1'),
  )
  .execute();
```

The compiler generalises this to N hops by recursively wrapping each hop's pipeline in `addFields(... .toArrayExpression().as(...))` of the parent, with a per-hop `define` for the join key.

### Cycle detection / depth bounds

- The compiler caps depth at `MAX_PIPELINE_DEPTH` (default 5; configurable per-spec). Beyond that, fall back to per-hop loop with a `console.warn`.
- The compiler does NOT detect cycles in the graph data (that requires data inspection). It detects cycles in the **spec** — e.g. a spec that revisits the same `(aType, axbType, bType)` triple at depth K should flag a warning.
- Per-hop `distinct(field('bUid'))` is added at the end of each sub-pipeline to dedupe within a hop, mirroring `traverse.ts`'s existing dedupe.

### Response-size guard

A 5-hop traversal with 100× branching factor is 10^10 docs in one response. Same `maxReads` budget as today's `traverse.ts`, but applied to the spec at compile time:

- Compiler estimates the worst-case response size as `Π(limitPerSource_i × N_i)` where `N_i` is the prior hop's expected output.
- If the estimate exceeds `maxReads`, the compiler refuses to emit a single pipeline and falls back to per-hop loop.
- `limitPerSource` is required at every hop in an engine-traversal spec; missing one is a compile-time error.

### Cross-graph hops

Same rule as Phase 6: cross-graph hops can't compose into one pipeline (different collection paths). The compiler bails out and falls back to per-hop loop for any spec containing a cross-graph hop.

### Public API shape

Open question — three options:

1. **Keep `traverse.ts`'s public API unchanged.** The capability gate inside `traverse.ts` decides at call time whether to compile-and-execute or loop. Pro: zero new surface, callers don't need to know the capability exists. Con: callers can't force engine-level mode for benchmarking.
2. **Add a typed `client.engineTraversal(spec)` method gated by the capability.** Pro: explicit. Con: duplicates `traverse.ts`'s API.
3. **Add `engineTraversal: 'auto' | 'force' | 'off'` option to the existing `traverse.run()`.** Default `'auto'` ⇒ same behaviour as option 1.

**Recommendation: option 3.** Smallest surface change, retains explicit-mode for testing, default is the same behaviour every existing caller already gets.

### Tests

- Compiler unit tests in isolation (10–15 cases): empty spec, 1-hop, 2-hop, cross-graph fallback, depth-cap fallback, response-size fallback, missing-limit-per-source error.
- Executor unit tests with vi.mock-Pipeline: 5–8 cases for tree-decode shape.
- Integration (gated): 1–2 cases against real Enterprise.

### Audit

Run `/audit`. Files touched: ~12.

### Exit criteria

- Enterprise declares `traversal.serverSide` and installs the new method.
- `traverse.run({ engineTraversal: 'auto' })` (default) routes through engine traversal on Enterprise for in-graph specs that fit the budget; falls back to per-hop on cross-graph or over-budget specs.
- Compiler and executor are independently unit-tested.
- Matrix and rules docs updated.
- Engine-traversal integration test demonstrates single-round-trip 3-hop fan-out (verified via SDK spy).

---

## Test matrix (final, after all three sub-phases)

| Capability             | firestore-standard  | firestore-enterprise      | sqlite | cloudflare-do |
| ---------------------- | ------------------- | ------------------------- | ------ | ------------- |
| `query.join`           | ✓ (chunked classic) | ✓ (Pipelines `equalAny`)  | ✓      | ✓             |
| `query.dml`            | —                   | ✓ when `previewDml: true` | ✓      | ✓             |
| `traversal.serverSide` | —                   | ✓                         | —      | —             |

Three matrix changes total. SQLite/DO rows untouched.

## Risks & mitigations

| Risk                                                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline DML stays `@beta` and the API shifts.                                                                                                           | Hide behind `previewDml: true` opt-in. Single helper in `firestore-bulk-dml.ts` is the only call site — easy to update. `console.warn` on first call so downstream is aware.                                                                                                                        |
| `equalAny` has an undocumented small-list cap.                                                                                                           | Integration test exercises 1 000-element list. If the call rejects, internalise chunking inside `runFirestorePipelineExpand` and document.                                                                                                                                                          |
| Engine-traversal response size explodes.                                                                                                                 | Compile-time response-size guard against `maxReads` budget. Compiler refuses to emit; falls back to per-hop loop.                                                                                                                                                                                   |
| Engine traversal hits a Pipeline depth limit we don't know about.                                                                                        | `MAX_PIPELINE_DEPTH = 5` default with fallback. Integration test against real Enterprise to discover the actual limit. Adjust default if needed.                                                                                                                                                    |
| Phase 13c's traversal compiler diverges from `traverse.ts`'s observable behaviour (different sort order, different dedup semantics, etc.).               | Per-hop `distinct(field('bUid'))` mirrors `traverse.ts`'s dedup. Sort goes through the same `Ordering` translation that `select` already uses. Integration test compares engine-traversal output against per-hop-loop output for the same spec — must be set-equal.                                 |
| Backfilling Standard's `query.join` makes Standard claim a capability it can only deliver via 30-element chunking — looks like a "lie" of the type-gate. | Document the chunking explicitly in the Standard backend's capability rationale. The capability says "I can do multi-source fan-out", not "I do it in one server-side call" — same framing as `query.aggregate` (Standard supports count/sum/avg but the capability descriptor doesn't sub-divide). |

## What an agent doing this work needs to confirm before starting

1. **Read this plan + the Phase 12 commit (`d42fb4c`) + the existing `firestore-fulltext.ts` / `firestore-geo.ts` / their unit tests** end-to-end. The pattern is mature; new helpers follow the same shape.
2. **Re-verify the d.ts line numbers** before relying on them. The references in this doc are pinned to `node_modules/@google-cloud/firestore/types/firestore.d.ts` as of the Phase 13 worktree's lockfile. If the version drifts, the line numbers may have moved (the typed surface should be stable).
3. **Decide order with the user.** The default order is 13a → 13b → 13c. 13c is the "engine-level traversal" payoff and the largest in scope; 13a is the smallest and unblocks 13c. 13b is independent of both.
4. **Don't promote Pipeline DML out of preview.** Until Google removes the `@beta` tag from `Pipeline.delete()` / `Pipeline.update()` in the typed surface, `previewDml` stays opt-in.

## Rollback plan

Each sub-phase is a separate commit. `git revert <sha>` cleanly removes any sub-phase without disturbing the others. No data migration; no file moves; only additive capability declarations and new helpers.
