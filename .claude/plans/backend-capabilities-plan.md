# Build Plan — Backend Capabilities Refactor

> **Companion doc:** [`.claude/backend-capabilities.md`](../backend-capabilities.md). Read it first. This plan executes the design captured there.

## Goals

1. Split `firegraph/firestore` into `firegraph/firestore-standard` and `firegraph/firestore-enterprise` so the edition is encoded in imports.
2. Introduce a typed `Capability` union and `BackendCapabilities` descriptor on `StorageBackend<C>`.
3. Make `GraphClient<C>` conditional — extension methods exist in the type only when `C` declares the capability.
4. Land all GA / GA-eligible Pipeline wins in this single PR: aggregations (portable), server-side DML cascades, multi-hop join traversal, projections, `findNearest`, full-text search, geospatial.
5. Maintain identical observable behavior of the **portable core API** across all backends.
6. No backwards compatibility. Single consumer; downstream packages refactor along with this.

## Non-goals (explicit)

- Editor UI changes (separate PR).
- MongoDB-compatible Enterprise.
- SQLite FTS5 / R\*Tree opt-in.
- Pipeline-in-transaction.
- Realtime listener API.

## Success criteria

- `pnpm typecheck` passes.
- `pnpm test:unit` passes.
- `pnpm test:integration` runs the new capability harness across `[firestore-standard, firestore-enterprise, sqlite, do]` with `pnpm test:emulator:integration` for Firestore-Enterprise pipeline paths against the real Firestore emulator (note: pipelines don't run on the emulator, so Enterprise pipeline tests run in a guarded "production-only" suite — see Phase 11).
- Every capability-gated extension is exercised by ≥ 1 test on every backend declaring it.
- `client.search(...)` is a TypeScript error against a `firestore-standard` backend.
- `pnpm build` produces all the new subpath outputs (`firestore-standard`, `firestore-enterprise`, `sqlite`).
- An `/audit` checkpoint at the end of every phase passes.

## Phase ordering (rationale)

The phases are ordered to minimize the size of broken-state windows:

1. **Foundation first** (Phase 1): add the capability descriptor without changing routing. Old code keeps working.
2. **Edition split next** (Phase 2): physically relocate Firestore code. This is the largest mechanical move; do it before adding new features so subsequent phases land in the new structure.
3. **Type-level gating** (Phase 3): turn on the conditional `GraphClient<C>` once everything is in its new home.
4. **New capabilities** (Phases 4–10): each is independent and can ship in any order, but the listed order minimizes cross-phase merge friction (aggregate first because both editions need it; DML and join next because they're the largest user wins; projections / vector / FTS / geo are smaller / extension-shaped).
5. **Cleanup** (Phase 11): docs, audits, removed dead code, final test consolidation.

Each phase ends with an `/audit` run per [CLAUDE.md](../../CLAUDE.md).

---

## Phase 0 — Snapshot & branch hygiene

**Goal:** establish baseline; agree on file moves before any code change.

**Actions:**

1. Confirm we're on `claude/relaxed-visvesvaraya-2d0c23` (the existing worktree branch). Do not create a new branch.
2. Run `pnpm typecheck && pnpm test:unit` and capture the pre-refactor baseline.
3. Read the design doc end-to-end before touching code. If anything is unclear, do not guess — surface the question.

**Exit criteria:** baseline green, design doc digested.

---

## Phase 1 — Capability descriptor (foundation, no behavior change)

**Goal:** add `Capability`, `BackendCapabilities`, and the `StorageBackend<C>` parameter without changing any execution path.

### Files

| File                                | Change                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                      | Add the `Capability` union (full list from §3 of the design doc). Export it.                                                                                   |
| `src/internal/backend.ts`           | Add `BackendCapabilities<C>` interface and `StorageBackend<C extends Capability = Capability>` generic. Default fallback keeps existing call sites compiling.  |
| `src/internal/firestore-backend.ts` | Add `capabilities: BackendCapabilities` to the existing impl. Declare the **superset** of Standard + Enterprise capabilities for now (we split it in Phase 2). |
| `src/internal/sqlite-backend.ts`    | Same — declare SQLite capabilities.                                                                                                                            |
| `src/cloudflare/backend.ts`         | Same — declare DO capabilities (identical to SQLite).                                                                                                          |
| `src/internal/routing-backend.ts`   | Add capability **intersection** logic: routing backend's `capabilities` is the intersection of all wrapped backends.                                           |
| `src/errors.ts`                     | Add `CapabilityNotSupportedError extends FiregraphError` with `code: 'CAPABILITY_NOT_SUPPORTED'`.                                                              |

### Concrete code

```ts
// src/types.ts
export type Capability =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  | 'search.fullText'
  | 'search.geo'
  | 'search.vector'
  | 'realtime.listen'
  | 'raw.firestore'
  | 'raw.sql';
```

```ts
// src/internal/backend.ts
import type { Capability } from '../types.js';

export interface BackendCapabilities<C extends Capability = Capability> {
  has<K extends Capability>(capability: K): this is BackendCapabilities<C & K>;
  values(): IterableIterator<C>;
  /** Type-level marker. Never read at runtime. */
  readonly _phantom?: C;
}

export function createCapabilities<C extends Capability>(
  caps: ReadonlySet<C>,
): BackendCapabilities<C> {
  return {
    has: (capability) => caps.has(capability as C),
    values: () => caps.values(),
  } as BackendCapabilities<C>;
}

export interface StorageBackend<C extends Capability = Capability> {
  readonly capabilities: BackendCapabilities<C>;
  // ...all existing fields unchanged
}
```

```ts
// src/internal/routing-backend.ts — intersection helper
function intersectCapabilities(parts: BackendCapabilities[]): BackendCapabilities {
  const sets = parts.map((p) => new Set(p.values()));
  const intersection = new Set<Capability>();
  if (sets.length === 0) return createCapabilities(intersection);
  for (const c of sets[0]) {
    if (sets.every((s) => s.has(c))) intersection.add(c);
  }
  return createCapabilities(intersection);
}
```

### Tests

- `tests/unit/capabilities.test.ts` (new): `createCapabilities` constructor, `has()` checks, `intersectCapabilities` correctness.
- Add a smoke test asserting each existing backend reports its expected set.

### Audit

Run `/audit` once Phase 1 lands. Files touched: ~7. Acceptable per the audit policy.

### Exit criteria

- `BackendCapabilities` exists and every backend declares it.
- No execution path changed; tests pass unchanged.
- TypeScript still compiles in legacy mode (`StorageBackend` without a parameter resolves to `StorageBackend<Capability>`).

---

## Phase 2 — Edition split: filesystem & entry points

**Goal:** physically move Firestore code into edition-specific directories and add new package subpaths. SQLite gets its own subpath too.

### Filesystem moves

```
src/internal/firestore-backend.ts     → src/firestore-enterprise/backend.ts (becomes Enterprise impl)
                                      → src/firestore-standard/backend.ts (NEW; classic-only impl, written from scratch using common helpers)
src/internal/firestore-adapter.ts     → src/internal/firestore-classic-adapter.ts (renamed; shared by both editions)
src/internal/pipeline-adapter.ts      → src/firestore-enterprise/pipeline-adapter.ts
src/internal/sqlite-backend.ts        → src/sqlite/backend.ts
src/internal/sqlite-sql.ts            → src/sqlite/sql.ts
src/internal/sqlite-payload-guard.ts  → STAYS (shared between sqlite and cloudflare backends)
src/internal/write-plan.ts            → STAYS
src/internal/serialization-tag.ts     → STAYS
src/internal/routing-backend.ts       → STAYS
src/cloudflare/**                     → STAYS (already isolated)
```

### New entry-point files

#### `src/firestore-standard/index.ts`

```ts
export { createFirestoreStandardBackend } from './backend.js';
export type { FirestoreStandardCapabilities, FirestoreStandardOptions } from './backend.js';

// Re-exports for ergonomic single-import usage:
export { createGraphClient } from '../client.js';
export { createRegistry, createMergedRegistry } from '../registry.js';
export { generateId } from '../id.js';
export { META_NODE_TYPE, META_EDGE_TYPE } from '../internal/constants.js';
```

#### `src/firestore-standard/backend.ts`

```ts
import { Firestore } from '@google-cloud/firestore';
import {
  createCapabilities,
  type BackendCapabilities,
  type StorageBackend,
} from '../internal/backend.js';
import { createFirestoreClassicAdapter } from '../internal/firestore-classic-adapter.js';
// ...

export type FirestoreStandardCapabilities =
  | 'core.read' | 'core.write' | 'core.transactions' | 'core.batch' | 'core.subgraph'
  | 'query.aggregate' | 'query.select' | 'search.vector'
  | 'realtime.listen' | 'raw.firestore';

const STANDARD_CAPS: ReadonlySet<FirestoreStandardCapabilities> = new Set([
  'core.read', 'core.write', 'core.transactions', 'core.batch', 'core.subgraph',
  'query.aggregate', 'query.select', 'search.vector',
  'realtime.listen', 'raw.firestore',
]);

export interface FirestoreStandardOptions {
  /** Reserved for future use. */
}

export function createFirestoreStandardBackend(
  db: Firestore,
  collectionPath: string,
  _options?: FirestoreStandardOptions,
): StorageBackend<FirestoreStandardCapabilities> {
  const adapter = createFirestoreClassicAdapter(db, collectionPath);
  return {
    capabilities: createCapabilities(STANDARD_CAPS),
    collectionPath,
    scopePath: '',
    // delegate all reads/writes to the classic adapter
    getDoc: adapter.getDoc,
    query: adapter.query,
    setDoc: adapter.setDoc,
    updateDoc: adapter.updateDoc,
    deleteDoc: adapter.deleteDoc,
    runTransaction: adapter.runTransaction,
    createBatch: adapter.createBatch,
    subgraph: (parentNodeUid, name) =>
      createFirestoreStandardBackend(db, `${collectionPath}/${parentNodeUid}/${name}`),
    removeNodeCascade: /* shared helper */,
    bulkRemoveEdges: /* shared helper */,
    // raw.firestore extension data lives here too:
    // (the GraphClient pulls these at construction)
  };
}
```

#### `src/firestore-enterprise/index.ts`

Symmetric to standard, but exports `createFirestoreEnterpriseBackend`, `FirestoreEnterpriseCapabilities`, `FirestoreEnterpriseOptions`.

#### `src/firestore-enterprise/backend.ts`

Wires the classic adapter for transactions / single-doc reads / writes / listeners, AND the pipeline adapter for `query()` (when `defaultQueryMode === 'pipeline'`, which is the default outside the emulator). `EmulatorAutoFallback` logic that today lives in `firestore-backend.ts` moves here.

```ts
export type FirestoreEnterpriseCapabilities =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.select'
  | 'query.join'
  | 'query.dml'
  | 'search.fullText'
  | 'search.geo'
  | 'search.vector'
  | 'realtime.listen'
  | 'raw.firestore';

export interface FirestoreEnterpriseOptions {
  defaultQueryMode?: 'pipeline' | 'classic';
}
```

#### `src/sqlite/index.ts`

```ts
export { createSqliteBackend } from './backend.js';
export type { SqliteCapabilities, SqliteBackendOptions } from './backend.js';
export { createGraphClient } from '../client.js';
export { createRegistry, createMergedRegistry } from '../registry.js';
export { generateId } from '../id.js';
export { META_NODE_TYPE, META_EDGE_TYPE } from '../internal/constants.js';
```

### Root index.ts: drop Firestore exports

```ts
// src/index.ts (after Phase 2)
export { createGraphClient } from './client.js';
export { createRegistry, createMergedRegistry, createBootstrapRegistry } from './registry.js';
export { createTraversal } from './traverse.js';
export { defineConfig } from './config.js';
export { defineViews } from './views.js';
export { discoverEntities } from './discover.js';
export { generateId } from './id.js';
export { FiregraphError /* all subclasses */ } from './errors.js';
export type {} from /* all public types */ './types.js';
// NO Firestore-specific exports; users import from a backend subpath.
```

### `package.json` `exports`

Add the three new entries from §5 of the design doc. Add corresponding `tsup` entry points to `tsup.config.ts`.

### `tsup.config.ts`

```ts
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/backend.ts',
    'src/react.ts',
    'src/svelte.ts',
    'src/query-client/index.ts',
    'src/cloudflare/index.ts',
    'src/firestore-standard/index.ts', // NEW
    'src/firestore-enterprise/index.ts', // NEW
    'src/sqlite/index.ts', // NEW
    'src/codegen/index.ts',
  ],
  // ...
});
```

### Update internal callers

Anything in `src/` that currently imports from `src/internal/firestore-backend.ts` etc. must be reviewed. Most of `src/client.ts`, `src/transaction.ts`, `src/batch.ts`, `src/query.ts`, `src/traverse.ts`, `src/bulk.ts` only depend on `StorageBackend` from `src/internal/backend.ts` — no changes needed for those.

The places that **directly construct** Firestore backends today (look for `createFirestoreBackend` callers) move to whichever edition they need. The editor server and any sample code in `tests/` are the most likely callers.

### Test moves

```
tests/integration/        → renamed to tests/integration/firestore-standard/  (currently emulator-based, classic-mode tests)
tests/integration-pipeline/ → renamed to tests/integration/firestore-enterprise/
tests/pipeline/            → renamed to tests/integration/firestore-enterprise-pipeline-internals/
tests/integration/        → existing SQLite tests (BACKEND=sqlite path) move under tests/integration/sqlite/
```

This is a big rename. Use `git mv` so history follows. Don't change test contents in this phase; just the locations.

### `pnpm` scripts (`package.json`)

Replace existing test scripts with:

```jsonc
{
  "scripts": {
    "test:integration:standard": "vitest run tests/integration/firestore-standard/",
    "test:integration:enterprise": "vitest run tests/integration/firestore-enterprise/",
    "test:integration:sqlite": "BACKEND=sqlite vitest run tests/integration/sqlite/",
    "test:integration:cloudflare": "vitest run tests/integration/cloudflare/",
    "test:integration": "pnpm test:integration:standard && pnpm test:integration:sqlite && pnpm test:integration:cloudflare && pnpm test:integration:enterprise",
    "test:emulator:integration": "bash tests/scripts/test-with-emulator.sh tests/integration/firestore-standard/",
  },
}
```

### `.claude/rules/` updates

- [.claude/rules/core-library.md](../rules/core-library.md): rewrite the "Dual-Mode Query Engine" section to reference the new structure. The old `queryMode` option is gone from core. Pipeline/classic selection happens inside `firestore-enterprise/backend.ts` only.
- [.claude/rules/cloudflare.md](../rules/cloudflare.md): no changes (DO backend is unchanged).
- Add `.claude/rules/backends.md` (NEW) — short pointer to `.claude/backend-capabilities.md` design doc, plus the loading rule:

```yaml
# Loads when editing
src/firestore-standard/**, src/firestore-enterprise/**, src/sqlite/**, src/cloudflare/backend.ts,
src/internal/backend.ts, src/internal/routing-backend.ts
```

### Audit

Run `/audit` after Phase 2. Files touched: ~30+ (file moves dominate). The audit will catch bad import paths and any place where `queryMode` is still being read.

### Exit criteria

- `pnpm build` produces `dist/firestore-standard/`, `dist/firestore-enterprise/`, `dist/sqlite/`.
- All existing tests pass under their new locations.
- `src/internal/firestore-backend.ts`, `src/internal/firestore-adapter.ts`, `src/internal/pipeline-adapter.ts`, `src/internal/sqlite-backend.ts`, `src/internal/sqlite-sql.ts` are gone (replaced by their new homes).
- `src/index.ts` does not import `@google-cloud/firestore` (verify by grepping the built `dist/index.js`).
- Each backend declares the correct capability set per the design matrix.

---

## Phase 3 — Type-level capability gating

**Goal:** parameterize `GraphClient<C>` so extension methods only appear when the backend declares them.

### Files

| File            | Change                                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`  | Add `CoreGraphClient`, `AggregateExtension`, `SelectExtension`, `JoinExtension`, `DmlExtension`, `FullTextSearchExtension`, `GeoExtension`, `VectorExtension`, `RawFirestoreExtension`, `RawSqlExtension` interfaces. Add the `GraphClient<C>` conditional type.           |
| `src/client.ts` | Change `createGraphClient` signature to `<C extends Capability>(backend: StorageBackend<C>, options?): GraphClient<C>`. The implementation defines all extension methods unconditionally (they runtime-check `backend.capabilities`); the type system gates accessibility. |
| `src/index.ts`  | Re-export `GraphClient` and the extension interfaces.                                                                                                                                                                                                                      |

### `src/types.ts` additions

Verbatim from §7 of the design doc. Specifically the `GraphClient<C>` definition:

```ts
export type GraphClient<C extends Capability = Capability> = CoreGraphClient &
  ('query.aggregate' extends C ? AggregateExtension : object) &
  ('query.select' extends C ? SelectExtension : object) &
  ('query.join' extends C ? JoinExtension : object) &
  ('query.dml' extends C ? DmlExtension : object) &
  ('search.fullText' extends C ? FullTextSearchExtension : object) &
  ('search.geo' extends C ? GeoExtension : object) &
  ('search.vector' extends C ? VectorExtension : object) &
  ('raw.firestore' extends C ? RawFirestoreExtension : object) &
  ('raw.sql' extends C ? RawSqlExtension : object);
```

### `src/client.ts` runtime-shape

The runtime `GraphClientImpl` stays a plain class with all methods defined. Each extension method begins with a capability check:

```ts
class GraphClientImpl implements GraphClient<Capability> {
  // ...core methods unchanged

  async aggregate<A extends AggregateSpec>(
    params: FindEdgesParams & { aggregates: A },
  ): Promise<AggregateResult<A>> {
    this.assertCapability('query.aggregate');
    // ...delegate to backend
  }

  async findNearest(params: FindNearestParams): Promise<GraphRecord[]> {
    this.assertCapability('search.vector');
    return this.backend.findNearest!(params); // backend method only present when capability is
  }

  private assertCapability(c: Capability): void {
    if (!this.backend.capabilities.has(c)) {
      throw new CapabilityNotSupportedError(c, [...this.backend.capabilities.values()]);
    }
  }
}
```

The cast at `createGraphClient`'s return type narrows the user-facing type:

```ts
export function createGraphClient<C extends Capability>(
  backend: StorageBackend<C>,
  options?: GraphClientOptions,
): GraphClient<C> {
  return new GraphClientImpl(backend, options) as unknown as GraphClient<C>;
}
```

### Backend method signatures

Backends gain optional methods for capability-gated operations. Optional because not every backend implements them:

```ts
// src/internal/backend.ts
export interface StorageBackend<C extends Capability = Capability> {
  // ...existing
  aggregate?(spec: AggregateSpec, filters: QueryFilter[]): Promise<Record<string, number>>;
  findEdgesProjected?<F extends string>(
    params: FindEdgesParams & { select: F[] },
  ): Promise<unknown[]>;
  expand?(params: ExpandParams): Promise<ExpandResult>;
  bulkDelete?(filters: QueryFilter[]): Promise<{ deleted: number }>;
  bulkUpdate?(filters: QueryFilter[], patch: UpdatePayload): Promise<{ updated: number }>;
  search?(params: FullTextSearchParams): Promise<StoredGraphRecord[]>;
  searchByDistance?(params: GeoSearchParams): Promise<StoredGraphRecord[]>;
  findNearest?(params: FindNearestParams): Promise<StoredGraphRecord[]>;
  rawFirestore?: { db: unknown; collectionPath: string };
  rawSql?: SqlExecutor;
}
```

For each capability the backend declares, the matching optional method **must** be implemented; for those it doesn't, the method is `undefined`. We don't add a phantom-link between capability and method at the type level — the runtime check is sufficient and the design doc commits to it.

### Tests

- `tests/unit/client-types.test-d.ts` (new — type test using `tsd` or `vitest`'s `expectTypeOf`):
  - `client: GraphClient<'core.read'>` does **not** have `.search`.
  - `client: GraphClient<'search.fullText'>` does have `.search`.
  - `client: GraphClient<FirestoreStandardCapabilities>` does not have `.aggregate`'s join / DML / FTS / geo siblings, etc.
  - One assertion per extension.

### Audit

Run `/audit`. Files touched: ~5.

### Exit criteria

- Type tests pass.
- Calling `createGraphClient(createFirestoreStandardBackend(...))` returns a client where `.search`, `.bulkDelete`, `.expand` are TypeScript errors.
- All existing tests still pass (the runtime didn't change behaviorally; capabilities matrix is the same as Phase 2).

---

## Phase 4 — `query.aggregate` (portable across all backends)

**Goal:** add the `aggregate()` extension. Implement on Standard, Enterprise, SQLite, DO. This is first because it's the smallest, most-portable feature and exercises the new extension pattern end-to-end.

### Files

| File                                                   | Change                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                         | Add `AggregateOp`, `AggregateSpec`, `AggregateResult`, `AggregateExtension`.                            |
| `src/client.ts`                                        | Add `aggregate()` method delegating to `backend.aggregate(spec, filters)`.                              |
| `src/firestore-standard/aggregate.ts` (new)            | Translate `AggregateSpec` to `runAggregationQuery` using `@google-cloud/firestore`'s `AggregateField`.  |
| `src/firestore-standard/backend.ts`                    | Wire `aggregate` method.                                                                                |
| `src/firestore-enterprise/pipeline-aggregate.ts` (new) | Translate `AggregateSpec` to a pipeline `aggregate()` stage.                                            |
| `src/firestore-enterprise/backend.ts`                  | Wire `aggregate` method.                                                                                |
| `src/sqlite/sql.ts`                                    | Add `compileAggregate()` that builds a `SELECT COUNT(*), AVG(json_extract(data, '$.field')) ...` query. |
| `src/sqlite/backend.ts`                                | Wire `aggregate` method.                                                                                |
| `src/cloudflare/sql.ts`                                | Mirror `compileAggregate` for the DO.                                                                   |
| `src/cloudflare/backend.ts`                            | Wire `aggregate` method.                                                                                |

### Public API

```ts
// Usage
const stats = await client.aggregate({
  aType: 'tour',
  axbType: 'hasDeparture',
  aggregates: {
    total: { op: 'count' },
    avgPrice: { op: 'avg', field: 'data.price' },
    minPrice: { op: 'min', field: 'data.price' },
  },
});
// stats: { total: number; avgPrice: number; minPrice: number }
```

### Per-backend implementation notes

**Firestore Standard** (`src/firestore-standard/aggregate.ts`):

```ts
import { AggregateField, type Firestore, type Query } from '@google-cloud/firestore';

export async function runAggregate(q: Query, spec: AggregateSpec): Promise<Record<string, number>> {
  const aggregations: Record<string, ReturnType<typeof AggregateField.count>> = {};
  for (const [alias, { op, field }] of Object.entries(spec)) {
    if (op === 'count') aggregations[alias] = AggregateField.count();
    else if (op === 'sum') aggregations[alias] = AggregateField.sum(field!);
    else if (op === 'avg') aggregations[alias] = AggregateField.average(field!);
    else
      throw new FiregraphError(
        'UNSUPPORTED_AGGREGATE',
        `Aggregate op '${op}' not supported on Firestore Standard. Standard supports count/sum/avg only.`,
      );
  }
  const snap = await q.aggregate(aggregations).get();
  // map back to Record<string, number>
}
```

Note: Standard does **not** support `min` / `max` aggregations. The Standard implementation throws `UNSUPPORTED_AGGREGATE` for those. This is allowed: backends declare `query.aggregate` if they support **at least** count/sum/avg. Document the per-backend matrix in the design doc and surface a clear error when callers ask for unsupported ops.

**Firestore Enterprise** (`src/firestore-enterprise/pipeline-aggregate.ts`):

```ts
import { Pipelines } from '@google-cloud/firestore';
// pipeline.aggregate(
//   Pipelines.count().as('total'),
//   Pipelines.avg(Pipelines.field('data.price')).as('avgPrice'),
//   Pipelines.min(Pipelines.field('data.price')).as('minPrice'),
// )
```

**SQLite / DO**:

```sql
SELECT
  COUNT(*) AS total,
  AVG(CAST(json_extract(data, '$.price') AS REAL)) AS avgPrice,
  MIN(CAST(json_extract(data, '$.price') AS REAL)) AS minPrice
FROM graph
WHERE aType = ? AND axbType = ?;
```

### Tests

- `tests/integration/_capability-harness.ts` (new): the matrix harness. See Phase 11 for full design; for Phase 4 land a minimal version.
- `tests/integration/query-aggregate/basic.test.ts` (new): runs against every backend declaring `query.aggregate`, asserts identical results.
- Per-backend variant tests for unsupported ops (e.g. min/max throws `UNSUPPORTED_AGGREGATE` on Standard).

### Audit

Run `/audit`. Files touched: ~10.

### Exit criteria

- All backends declare and implement `query.aggregate`.
- Capability harness runs the aggregate suite on all four backends and passes.
- Standard's per-op limitation surfaces a clear error.

---

## Phase 5 — `query.dml` server-side cascades

**Goal:** add `bulkDelete()` / `bulkUpdate()` extensions. Use them to speed up `bulk.ts` cascade operations on backends that support DML.

### Files

| File                                             | Change                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                   | Add `DmlExtension`, `BulkUpdatePatch` types.                                                                                                                                                                          |
| `src/client.ts`                                  | Add `bulkDelete()` / `bulkUpdate()` methods.                                                                                                                                                                          |
| `src/firestore-enterprise/pipeline-dml.ts` (new) | Pipeline DML stage builders.                                                                                                                                                                                          |
| `src/firestore-enterprise/backend.ts`            | Wire `bulkDelete` / `bulkUpdate`.                                                                                                                                                                                     |
| `src/sqlite/sql.ts`                              | Add `compileBulkDelete` / `compileBulkUpdate` returning the SQL DELETE / UPDATE for the given filters. Reuse the existing `flattenPatch` / `DataPathOp` machinery from `src/internal/write-plan.ts` for `bulkUpdate`. |
| `src/sqlite/backend.ts`                          | Wire `bulkDelete` / `bulkUpdate`.                                                                                                                                                                                     |
| `src/cloudflare/sql.ts`                          | Mirror.                                                                                                                                                                                                               |
| `src/cloudflare/backend.ts`                      | Wire.                                                                                                                                                                                                                 |
| `src/bulk.ts`                                    | Branch on `caps.has('query.dml')`. If yes, route cascade deletes through `backend.bulkDelete`. If no (Standard), retain the existing fetch-then-delete loop.                                                          |

### Implementation notes

**Cascade rewrite in `bulk.ts`:**

```ts
// Before: iterate findEdges -> deleteDoc
// After:
async function removeNodeCascade(uid, reader, options) {
  const { backend } = reader as { backend: StorageBackend };
  if (backend.capabilities.has('query.dml')) {
    const outResult = await backend.bulkDelete!([{ field: 'aUid', op: '==', value: uid }]);
    const inResult = await backend.bulkDelete!([{ field: 'bUid', op: '==', value: uid }]);
    return { edgesDeleted: outResult.deleted + inResult.deleted };
  }
  // existing per-row loop unchanged
}
```

**SQLite payload guard:** `bulkUpdate` uses the same `assertJsonSafePayload` we already enforce on `compileSet` / `compileUpdate` replaceData. Cross-reference [.claude/rules/migration.md](../rules/migration.md) — the same constraint applies.

### Tests

- `tests/integration/query-dml/cascade-delete.test.ts` (new).
- `tests/integration/query-dml/bulk-update.test.ts` (new).
- Both run on `[firestore-enterprise, sqlite, cloudflare]`. Skipped on `firestore-standard`.
- Add a regression test asserting that `bulk.removeSubgraph` produces identical observable results on Standard (loop) and Enterprise (DML) by running the same scenario against both and comparing post-state.

### Audit

Run `/audit`. Files touched: ~10.

### Exit criteria

- Bulk cascade deletes use server-side DML on Enterprise and both SQL backends.
- Standard fallback unchanged and still passes its tests.
- Wall-clock regression test (informational, not gating): cascade of a 100-edge node should be > 5x faster on Enterprise vs Standard. Capture timings in a comment.

---

## Phase 6 — `query.join` multi-hop expansion

**Goal:** add the `expand()` extension and use it inside `traverse.ts` when the backend supports `query.join`.

### Files

| File                                                | Change                                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                      | Add `ExpandParams`, `ExpandHop`, `ExpandResult`, `JoinExtension`.                                                                                              |
| `src/client.ts`                                     | Add `expand()` method.                                                                                                                                         |
| `src/firestore-enterprise/pipeline-expand.ts` (new) | Build the pipeline subquery for one hop, including target-node hydration via subqueries.                                                                       |
| `src/firestore-enterprise/backend.ts`               | Wire `expand`.                                                                                                                                                 |
| `src/sqlite/sql.ts`                                 | `compileExpand` — emits a SQL `JOIN` between the edge table and node table.                                                                                    |
| `src/sqlite/backend.ts`                             | Wire `expand`.                                                                                                                                                 |
| `src/cloudflare/**`                                 | Mirror.                                                                                                                                                        |
| `src/traverse.ts`                                   | Branch on `caps.has('query.join')`. If yes, emit one `expand()` call per depth (replacing the per-hop fanout loop). If no, retain the existing semaphore loop. |

### Pipeline shape (Enterprise)

For each depth, given a source uid set S:

```ts
// pseudo
db.pipeline()
  .collection(edgesCollection)
  .where(
    P.and(
      P.equalAny('aUid', S),
      P.equal('axbType', hop.axbType),
      /* hop.where translated */
    ),
  )
  .limit(hop.limitPerSource * S.length) // upper bound
  .subcollection(nodesCollection, { join: { localField: 'bUid', foreignField: 'uid' } })
  .execute();
```

The exact subquery API surface matches the GA `subcollection` / join surface; consult the Firestore SDK types at implementation time.

### Cross-graph hops

`src/cross-graph.ts` resolves hops that target a different graph. Cross-graph hops cannot be expressed as a single pipeline (different collection paths), so `expand()` falls back to per-hop loop for cross-graph edges. Document this in code and in `.claude/rules/`.

### Tests

- `tests/integration/query-join/single-hop-fanout.test.ts` (new).
- `tests/integration/query-join/multi-hop-deep.test.ts` (new): 3-hop traversal with target hydration.
- Cross-graph case: `tests/integration/query-join/cross-graph.test.ts` — asserts fallback to per-hop on Enterprise (because pipeline cross-graph isn't supported).
- Run on `[firestore-enterprise, sqlite, cloudflare]`. Standard runs the per-hop variant of the same test inputs and compares results.

### Audit

Run `/audit`. Files touched: ~10.

### Exit criteria

- Multi-hop traversal observable behavior is identical on all backends.
- `firestore-enterprise` finishes a 1-hop fanout to 100 sources in 1 round trip (verify via spy on the Firestore SDK).
- `firestore-standard` continues to use the per-hop loop and still passes.

---

## Phase 7 — `query.select` projection

**Goal:** server-side field projection for low-bandwidth list views.

### Files

| File                                  | Change                                              |
| ------------------------------------- | --------------------------------------------------- |
| `src/types.ts`                        | Add `SelectExtension`, `findEdgesProjected`.        |
| `src/client.ts`                       | Add `findEdgesProjected()`.                         |
| `src/firestore-standard/backend.ts`   | Use classic `Query.select(...)`.                    |
| `src/firestore-enterprise/backend.ts` | Use pipeline `select()` stage.                      |
| `src/sqlite/backend.ts`               | Build SQL `SELECT json_extract(data, '$.f1'), ...`. |
| `src/cloudflare/backend.ts`           | Mirror.                                             |

### API

```ts
const titles = await client.findEdgesProjected({
  aType: 'tour',
  axbType: 'hasDeparture',
  select: ['title', 'date'] as const,
});
// titles: Array<{ title: unknown; date: unknown }>
```

The return type is `Array<Pick<Record<string, unknown>, F[number]>>`. Don't promise stronger types yet; that requires per-entity codegen integration which is a separate phase.

### Tests

`tests/integration/query-select/basic.test.ts` (new). Runs on all backends declaring `query.select`.

### Audit

Run `/audit`.

### Exit criteria

- All backends declaring `query.select` return only the requested fields.
- Verify byte savings on a known workload (informational: pick a fixture with large `data` blobs and assert wire payload < 25% of full-doc).

---

## Phase 8 — `search.vector` (Enterprise + Standard)

**Goal:** expose `findNearest()` on both Firestore editions.

### Files

| File                                  | Change                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                        | Add `VectorExtension`, `FindNearestParams`.                                                                                                                                                                         |
| `src/client.ts`                       | Add `findNearest()`.                                                                                                                                                                                                |
| `src/firestore-standard/backend.ts`   | Use classic `Query.findNearest({ vectorField, queryVector, limit, distanceMeasure })` (the legacy vector index API — **faster** than pipelines for ANN today).                                                      |
| `src/firestore-enterprise/backend.ts` | Pick implementation: prefer the classic API if user requested speed; fallback to pipeline `findNearest` stage if user wants to compose with other pipeline stages. Default to classic for parity. Document in code. |

### API

```ts
const similar = await client.findNearest({
  aType: 'tour',
  vectorField: 'data.embedding',
  queryVector: vector,
  limit: 10,
  distanceMeasure: 'COSINE',
});
```

### Tests

`tests/integration/search-vector/findNearest.test.ts` (new). Runs on `[firestore-standard, firestore-enterprise]`. Skipped on SQLite / DO.

### Audit

Run `/audit`.

### Exit criteria

- Vector search returns identical (top-K) results across both Firestore editions for the same fixture.

---

## Phase 9 — `search.fullText` (Enterprise only, Preview)

**Goal:** add full-text search via pipeline `search()` stage.

### Files

| File                                                | Change                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                                      | Add `FullTextSearchExtension`, `FullTextSearchParams`.                                                           |
| `src/client.ts`                                     | Add `search()`.                                                                                                  |
| `src/firestore-enterprise/pipeline-search.ts` (new) | Build the pipeline starting with `.search(...)` (must be first stage), then optional `where()` filters for type. |
| `src/firestore-enterprise/backend.ts`               | Wire `search`.                                                                                                   |

### API

```ts
const hits = await client.search({
  query: 'tropical beach',
  fields: ['data.title', 'data.description'],
  limit: 20,
});
```

### Per-type indexing constraint

Pipeline `.search()` must be the first stage. If `aType` is supplied, the implementation must scope the search to a per-type collection (using the existing `aType` indexing layout) rather than emitting a follow-up `where(aType==…)`.

### Tests

`tests/integration/search-full-text/basic.test.ts` (new). Runs on `firestore-enterprise` only. Skipped elsewhere by capability.

### Audit

Run `/audit`.

### Exit criteria

- Full-text search returns ranked results.
- Capability `search.fullText` is **only** declared on `firestore-enterprise`.
- Tests in this suite cleanly skip on other backends.

---

## Phase 10 — `search.geo` (Enterprise only, Preview)

**Goal:** add geospatial search.

### Files

| File                                             | Change                                 |
| ------------------------------------------------ | -------------------------------------- |
| `src/types.ts`                                   | Add `GeoExtension`, `GeoSearchParams`. |
| `src/client.ts`                                  | Add `searchByDistance()`.              |
| `src/firestore-enterprise/pipeline-geo.ts` (new) | Build the geospatial pipeline.         |
| `src/firestore-enterprise/backend.ts`            | Wire.                                  |

### API

```ts
const nearby = await client.searchByDistance({
  aType: 'restaurant',
  geoField: 'data.location',
  point: { lat: 37.7749, lng: -122.4194 },
  radiusMeters: 5_000,
  limit: 50,
  orderByDistance: true,
});
```

### Tests

`tests/integration/search-geo/distance.test.ts` (new). Runs on `firestore-enterprise` only.

### Audit

Run `/audit`.

### Exit criteria

- Geo search returns results ordered by distance to the query point.

---

## Phase 11 — Cleanup, docs, audits, harness consolidation

**Goal:** polish, document, validate.

### Capability harness

`tests/integration/_capability-harness.ts` finalized. Shape:

```ts
import { describe } from 'vitest';
import type { Capability, StorageBackend } from '../../src/internal/backend.js';

interface BackendFactory {
  name: string;
  capabilities: ReadonlySet<Capability>;
  create: () => Promise<StorageBackend>;
  teardown: (b: StorageBackend) => Promise<void>;
}

const FACTORIES: BackendFactory[] = [
  { name: 'firestore-standard' /* ... */ },
  { name: 'firestore-enterprise' /* ... */ }, // gated by FIREGRAPH_ENTERPRISE=1
  { name: 'sqlite' /* ... */ },
  { name: 'cloudflare-do' /* ... */ },
];

export function describeCapability(
  capability: Capability,
  body: (factory: BackendFactory) => void,
) {
  for (const factory of FACTORIES) {
    if (!factory.capabilities.has(capability)) continue;
    describe(`[${factory.name}] capability=${capability}`, () => body(factory));
  }
}
```

Each capability test file:

```ts
import { describeCapability } from '../_capability-harness.js';
describeCapability('query.aggregate', (factory) => {
  // test cases reused across all backends declaring this capability
});
```

### Emulator note

Pipelines do not run on the Firestore emulator. Enterprise pipeline tests must run against a real Firestore Enterprise database. Gate them behind `FIREGRAPH_ENTERPRISE=1` and a `FIREGRAPH_ENTERPRISE_DB_URL` env var. CI sets these from a service account; local runs skip them by default. Add a clear console warning when the harness skips the Enterprise factory.

### Documentation

- Rewrite [.claude/rules/core-library.md](../rules/core-library.md) "Dual-Mode Query Engine" section with the new model.
- Add `.claude/rules/backends.md` (loads on backend file edits) — short pointer to the design doc plus capability matrix table.
- Update [.claude/rules/architecture.md](../rules/architecture.md) "Key Modules" table with the new file layout.
- Update [CLAUDE.md](../../CLAUDE.md) Commands section if `pnpm` script names changed.
- Add a top-level `README.md` section on edition selection (which backend to import for which database).

### Final audit

Run `/audit` over the whole branch. Address any findings.

### Exit criteria

- All previous phase exit criteria still hold.
- `pnpm typecheck && pnpm test:unit && pnpm test:integration` all pass.
- All capability suites green on every backend declaring them.
- Rules files updated.
- `git log` reads as a coherent series of phase commits.

---

## Test matrix (final)

| Suite                     | Standard                | Enterprise  | SQLite | DO  |
| ------------------------- | ----------------------- | ----------- | ------ | --- |
| `core/`                   | ✓                       | ✓           | ✓      | ✓   |
| `query-aggregate/`        | ✓                       | ✓           | ✓      | ✓   |
| `query-aggregate/min-max` | ✗ (Standard limitation) | ✓           | ✓      | ✓   |
| `query-select/`           | ✓                       | ✓           | ✓      | ✓   |
| `query-join/`             | — (skipped)             | ✓           | ✓      | ✓   |
| `query-dml/`              | — (skipped)             | ✓           | ✓      | ✓   |
| `search-full-text/`       | —                       | ✓ (Preview) | —      | —   |
| `search-geo/`             | —                       | ✓ (Preview) | —      | —   |
| `search-vector/`          | ✓                       | ✓           | —      | —   |

CI runs all four backends in parallel jobs. Enterprise pipeline jobs gated on the env var; absent gates skip with a warning, do not fail.

---

## Rollback plan

If the refactor lands and a downstream consumer hits a blocker:

- Revert is a single PR revert because everything ships in one PR.
- Capability descriptors are additive at runtime; reverting the type-level changes keeps runtime correctness even if types regress to the old shape.
- The biggest non-revertible item is the file structure / subpath split. Keep the moves clean (`git mv`) so a revert restores the old paths cleanly.

---

## Risks & mitigations

| Risk                                                                           | Mitigation                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipelines `subcollection` / join GA surface differs from pre-GA in subtle ways | Implement against the latest `@google-cloud/firestore` v8.x; pin version in `peerDependencies`. Capture exact SDK version in test fixtures.                                                                             |
| Enterprise emulator has no pipeline support                                    | Phase 11 harness gates Enterprise tests behind a real-DB env var. Provide setup script.                                                                                                                                 |
| Bulk DML on Enterprise hits server-side timeouts on very large filter sets     | Mirror the existing `bulk.ts` pagination strategy: chunk into max-N batches if the matched set exceeds a threshold (e.g. 10k). Add a `BulkOptions.maxPerCall` knob.                                                     |
| Cross-graph multi-hop bypasses `expand`                                        | Document explicitly. The fallback is correct, just not as fast. Don't ship a half-correct cross-graph join.                                                                                                             |
| Dropping `queryMode` from core options breaks downstream callers               | Single consumer is the maintainer. They've authorized the breaking change. Update consumer in the same PR cycle.                                                                                                        |
| `realtime.listen` declared on Enterprise but pipelines don't support it        | The capability is "the backend can support listeners (via classic API)." Listeners route through the classic adapter inside `firestore-enterprise/backend.ts`. If we add a listener method, it explicitly uses classic. |
| Pipeline `findNearest` is slower than classic vector index                     | Phase 8 default routes through classic on both editions. Pipeline `findNearest` is reachable via `client.raw.firestore` for power users.                                                                                |

---

## What an agent doing this work needs to confirm before starting

1. They've read **both** docs — design and plan — end-to-end.
2. They've confirmed access to a Firestore Enterprise database for Phase 6 / 9 / 10 testing, OR the maintainer has accepted that Enterprise pipeline suites are landed without local CI runs.
3. They understand that this PR replaces multiple existing files via `git mv` (Phase 2). They will not write new files where moves are appropriate; preserving git history is required.
4. They will not introduce new top-level exports from `src/index.ts` for vendor-specific code. Anything Firestore- or SQLite-specific lives in its subpath.
5. They will run `/audit` at the end of every phase, not batched at the end.
