/**
 * Pipelines-based DML for Firestore Enterprise (`query.dml`, Phase 13b).
 *
 * Translates `bulkDelete(filters)` / `bulkUpdate(filters, patch)` into a
 * single server-side pipeline:
 *
 *   db.pipeline().collection(path).where(<filters>).delete().execute()
 *   db.pipeline().collection(path).where(<filters>).update([…transforms]).execute()
 *
 * Both stages are `@beta` in `@google-cloud/firestore@8.5.0`
 * (`Pipeline.delete()` at `firestore.d.ts:12647`, `Pipeline.update(transformedFields)`
 * at `firestore.d.ts:12662`). The Enterprise backend gates this whole helper
 * behind an opt-in `previewDml: true` flag and emits a one-time `console.warn`
 * on first call — see `firestore-enterprise/backend.ts`.
 *
 * Why a separate helper rather than reusing `pipeline-adapter.ts`: the adapter
 * is read-only by design (it returns `StoredGraphRecord[]`). DML stages
 * mutate, return an affected-row count, and obey different empty-filter
 * defaults (an empty `where` would delete the whole collection — we reject
 * that at the boundary as defense-in-depth, mirroring `DORPCBackend`'s
 * empty-filter rejection at the wire).
 *
 * Result decoding: `Pipeline.delete()` and `Pipeline.update(...)` return a
 * `PipelineSnapshot` whose `results` array contains one entry per affected
 * document (the documents the stage acted on). We use `results.length` as
 * the affected-row count, matching `BulkResult.deleted` / parity with the
 * SQLite RETURNING-driven count. If the SDK changes the result shape when
 * the stages graduate from `@beta`, this is the only call site to update.
 */

import type { Firestore, Pipelines, Timestamp } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { BulkOptions, BulkResult, BulkUpdatePatch, QueryFilter } from '../types.js';
import { flattenPatch } from './write-plan.js';

/**
 * Lazily loaded Pipelines module + Timestamp class. Same dynamic-import
 * pattern as `pipeline-adapter.ts`, `firestore-fulltext.ts`, and
 * `firestore-expand.ts` — keeps the `@google-cloud/firestore` Pipelines
 * code out of the load graph for callers that never opt into preview DML.
 */
let _Pipelines: typeof Pipelines | null = null;
let _Timestamp: typeof Timestamp | null = null;

async function getFirestoreSurface(): Promise<{
  P: typeof Pipelines;
  Ts: typeof Timestamp;
}> {
  if (!_Pipelines || !_Timestamp) {
    const mod = await import('@google-cloud/firestore');
    _Pipelines = mod.Pipelines;
    _Timestamp = mod.Timestamp;
  }
  return { P: _Pipelines, Ts: _Timestamp };
}

/**
 * A field-name segment that needs no backtick escaping in a Firestore
 * field-path string. Mirrors `@google-cloud/firestore`'s internal
 * `UNESCAPED_FIELD_NAME_RE` (`src/path.js`). Anything not matching — a
 * leading digit, a hyphen, a literal dot, etc. — must be backtick-quoted.
 */
const UNESCAPED_FIELD_NAME_RE = /^[_A-Za-z][_A-Za-z0-9]*$/;

/**
 * Encode `['data', ...segments]` as Firestore's canonical field-path
 * string, the same encoding `FieldPath.formattedName` produces. The
 * Pipeline `update([...])` stage carries each set op as an
 * `AliasedExpression` whose alias the server parses as a field path
 * (dots mean nesting), and `.as()` only accepts a string — there is no
 * `FieldPath`-object overload on the typed surface. So we hand it the
 * canonical string form: plain segments stay bare (byte-identical to the
 * pre-fix `data.a.b` for normal keys, so existing Enterprise behavior is
 * unchanged), and exotic segments are backtick-wrapped with `\` and
 * `` ` `` escaped. This is what makes a `generateId()`-shaped leading-digit
 * key (`'4f9Kq_2bN'`) or a key containing a literal dot (`'a.b'`)
 * round-trip as a single literal key instead of silently mis-nesting.
 */
function buildDataPathAlias(segments: readonly string[]): string {
  const encoded = segments.map((seg) =>
    UNESCAPED_FIELD_NAME_RE.test(seg)
      ? seg
      : '`' + seg.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`',
  );
  return ['data', ...encoded].join('.');
}

/**
 * Build the Pipelines `BooleanExpression` for one `QueryFilter`. Mirrors
 * `pipeline-adapter.ts`'s `buildFilterExpression` exactly — kept as a
 * private helper here so this module doesn't reach into the Enterprise
 * package's adapter module (helpers under `internal/` should not depend
 * on per-edition modules).
 */
function buildFilterExpression(
  P: typeof Pipelines,
  filter: QueryFilter,
): Pipelines.BooleanExpression {
  const { field: fieldName, op, value } = filter;
  switch (op) {
    case '==':
      return P.equal(fieldName, value);
    case '!=':
      return P.notEqual(fieldName, value);
    case '<':
      return P.lessThan(fieldName, value);
    case '<=':
      return P.lessThanOrEqual(fieldName, value);
    case '>':
      return P.greaterThan(fieldName, value);
    case '>=':
      return P.greaterThanOrEqual(fieldName, value);
    case 'in':
      return P.equalAny(fieldName, value as Array<unknown>);
    case 'not-in':
      return P.notEqualAny(fieldName, value as Array<unknown>);
    case 'array-contains':
      return P.arrayContains(fieldName, value);
    case 'array-contains-any':
      return P.arrayContainsAny(fieldName, value as Array<unknown>);
    default:
      throw new FiregraphError(
        `bulkDelete/bulkUpdate: unsupported filter op "${op}" for pipeline DML.`,
        'INVALID_QUERY',
      );
  }
}

/**
 * Compose `where(and(... filters))`, normalising the 0/1/N-filter cases.
 * Empty `filters` is rejected by the caller; this helper assumes ≥ 1.
 */
function applyWhere(
  P: typeof Pipelines,
  pipeline: Pipelines.Pipeline,
  filters: readonly QueryFilter[],
): Pipelines.Pipeline {
  const exprs = filters.map((f) => buildFilterExpression(P, f));
  if (exprs.length === 1) {
    return pipeline.where(exprs[0]);
  }
  const [first, second, ...rest] = exprs;
  return pipeline.where(P.and(first, second, ...rest));
}

/**
 * Reject empty filter lists at the helper boundary. An unscoped
 * `pipeline().collection(path).delete()` would erase the whole graph
 * (or the whole subgraph), so we make the caller name a predicate.
 * `bulkDelete` / `bulkUpdate` callers always have at least the
 * scope-bounding filter (subgraph isolation is enforced by the parent
 * collection path, not by an explicit `scope` predicate the way SQLite
 * does it — Firestore's collection path IS the scope), but the public
 * `client.bulkDelete()` permits a no-filter call which should not
 * compose into a wholesale erase here.
 */
function assertNonEmptyFilters(filters: readonly QueryFilter[], op: 'delete' | 'update'): void {
  if (filters.length === 0) {
    throw new FiregraphError(
      `bulk${op === 'delete' ? 'Delete' : 'Update'}() on Firestore requires at least one filter; ` +
        `an empty filter list would target the whole collection. To wipe a subgraph, use ` +
        `removeNodeCascade() on the parent node instead.`,
      'INVALID_QUERY',
    );
  }
}

/**
 * Server-side bulk DELETE.
 *
 * Pipeline shape:
 *
 *   db.pipeline().collection(path).where(...).delete().execute()
 *
 * Decode: `snap.results.length` ⇒ `BulkResult.deleted`. `batches: 1`
 * because Pipeline DML is single-statement; `errors: []` on success
 * (a thrown error propagates up — there is no per-batch retry surface
 * here, mirroring the SQLite `bulkDelete` which also throws rather than
 * returning a partial result).
 */
export async function runFirestorePipelineDelete(
  db: Firestore,
  collectionPath: string,
  filters: QueryFilter[],
  _options?: BulkOptions,
): Promise<BulkResult> {
  assertNonEmptyFilters(filters, 'delete');
  const { P } = await getFirestoreSurface();
  let pipeline = db.pipeline().collection(collectionPath);
  pipeline = applyWhere(P, pipeline, filters);
  const snap = await pipeline.delete().execute();
  // @google-cloud/firestore@8.5.0 @beta: results contains one entry per
  // affected document. If this changes on graduation, this is the call site
  // to update (see module docstring).
  return {
    deleted: snap.results.length,
    batches: 1,
    errors: [],
  };
}

/**
 * Server-side bulk UPDATE.
 *
 * Translation:
 *
 *   1. `flattenPatch(patch.data)` → `DataPathOp[]`. Each terminal leaf
 *      becomes one transform on the row. Path validation lives in
 *      `flattenPatch` / `assertSafePath`.
 *   2. `delete: true` ops are rejected with `INVALID_QUERY`. The typed
 *      `Pipeline.update(AliasedExpression[])` surface in 8.5.0 has no
 *      sentinel for "remove this field"; emulating one would require a
 *      read-modify-write loop, which defeats the single-statement DML
 *      goal. Use the regular `replaceEdge` / `replaceNode` path or
 *      `bulkRemoveEdges` for delete-leaning patches.
 *   3. Each set op becomes `constant(value).as(<canonical field path>)`,
 *      where the alias is built by `buildDataPathAlias` — Firestore's
 *      canonical `FieldPath.formattedName` string encoding (plain segments
 *      bare, exotic ones backtick-escaped). The server parses the alias as
 *      a field path, so this is what lets a leading-digit or dot-containing
 *      key round-trip as one literal key instead of mis-nesting. Integration
 *      tests against real Enterprise pin the round trip.
 *   4. `updatedAt` is stamped with `constant(Timestamp.now())`. This is
 *      a client-side timestamp (Pipeline `update` doesn't accept a
 *      `FieldValue.serverTimestamp()` sentinel — it only takes typed
 *      `AliasedExpression`s), matching SQLite's `compileBulkUpdate(..., Date.now())`.
 *
 * Decode: same shape as delete — `snap.results.length` is the affected
 * row count surfaced as `BulkResult.deleted` (the field's name is a
 * legacy from cascade-delete; for an update, "deleted" is the
 * affected-row count by convention — same as SQLite `bulkUpdate`).
 */
export async function runFirestorePipelineUpdate(
  db: Firestore,
  collectionPath: string,
  filters: QueryFilter[],
  patch: BulkUpdatePatch,
  _options?: BulkOptions,
): Promise<BulkResult> {
  assertNonEmptyFilters(filters, 'update');

  const ops = flattenPatch(patch.data);
  if (ops.length === 0) {
    throw new FiregraphError(
      'bulkUpdate(): patch.data produced no field updates. An empty patch ' +
        'would only stamp updatedAt, which is almost certainly a bug.',
      'INVALID_QUERY',
    );
  }
  for (const op of ops) {
    if (op.delete) {
      throw new FiregraphError(
        `bulkUpdate(): preview Pipeline DML does not support deleteField() sentinels ` +
          `(no typed delete-transform on @google-cloud/firestore@8.5.0's ` +
          `Pipeline.update(AliasedExpression[])). Drop the delete from the patch ` +
          `or use replaceEdge/replaceNode for the affected rows.`,
        'INVALID_QUERY',
      );
    }
  }

  const { P, Ts } = await getFirestoreSurface();
  const transforms: Pipelines.AliasedExpression[] = ops.map((op) => {
    const alias = buildDataPathAlias(op.path);
    // `constant(value)` in the Pipelines surface accepts a fixed set of
    // primitive / Firestore-special types; we cast through `unknown` because
    // patch values are user-defined and the typed overloads don't expose a
    // catch-all. If the value type isn't supported by `constant(...)`, the
    // SDK rejects at execute time with a clear error.
    return P.constant(op.value as never).as(alias);
  });
  // Stamp updatedAt last so the SDK's `update` stage sees a single coherent
  // transform list. Matches the order in `buildFirestoreUpdate`.
  transforms.push(P.constant(Ts.now()).as('updatedAt'));

  let pipeline = db.pipeline().collection(collectionPath);
  pipeline = applyWhere(P, pipeline, filters);
  const snap = await pipeline.update(transforms).execute();
  // @google-cloud/firestore@8.5.0 @beta: results contains one entry per
  // affected document. If this changes on graduation, this is the call site
  // to update (see module docstring).
  return {
    deleted: snap.results.length,
    batches: 1,
    errors: [],
  };
}
