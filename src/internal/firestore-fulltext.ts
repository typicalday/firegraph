/**
 * Shared Pipelines-API full-text search translation for Firestore Enterprise.
 *
 * Translates a `fullTextSearch({ ... })` call into a
 * `db.pipeline().collection(path).search({ query: documentMatches(...), addFields: [score().as('_score')] }).where(...).limit(N).execute()`
 * pipeline and decodes the result. Only the Enterprise backend wires this
 * helper today — Firestore Standard does not support the FTS index at all
 * (an Enterprise-only product feature), and the SQLite-shaped backends
 * have no native FTS index.
 *
 * Why pipelines (not classic): Firestore's classic Query API has no FTS
 * primitive. The 8.5.0 SDK exposes typed `documentMatches` /
 * `geoDistance` / `score` functions plus the `Pipeline.search(...)`
 * stage; we use them directly and avoid the `rawStage(...)` escape
 * hatch.
 *
 * The `search` stage **must be the first stage** of a pipeline (per the
 * `@beta` SDK docstring at `Pipeline.search`). Identifying filters
 * (`aType` / `axbType` / `bType`) therefore go into a follow-up
 * `where(...)` stage, not into the `search.query` expression — composing
 * with `documentMatches` via `and(...)` is unsupported on the search
 * query path. The trade-off: identifying filters narrow *after* the
 * index walk rather than constraining its scope. For per-edge-type
 * search, callers should rely on Firestore's collection-scoped indexes
 * (one FTS index per `aType` collection); the post-search `where` is a
 * safety net, not a primary scope mechanism.
 *
 * Migrations are not applied to the result. The contract on
 * `StorageBackend.fullTextSearch` documents the rationale: the FTS
 * index walked the raw stored shape, and rehydrating through the
 * migration pipeline would change the candidate set the index already
 * scored.
 */

import type { Firestore, Pipelines } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { FullTextSearchParams, StoredGraphRecord } from '../types.js';

/**
 * Built-in envelope fields that must NOT appear in `fields`. Search
 * targets live inside `data`; the envelope is reserved for firegraph
 * metadata and is not text-indexable. Mirrors the projection /
 * vector-field rejection list.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'aType',
  'aUid',
  'axbType',
  'bType',
  'bUid',
  'createdAt',
  'updatedAt',
  'v',
]);

/**
 * Normalise a caller-supplied search-target field path. Bare names
 * rewrite to `data.<name>`; `'data'` and `'data.*'` pass through;
 * envelope fields are rejected.
 */
export function normalizeFullTextFieldPath(field: string): string {
  if (ENVELOPE_FIELDS.has(field)) {
    throw new FiregraphError(
      `fullTextSearch(): field '${field}' is a built-in envelope field — ` +
        `text-indexed fields must live under \`data.*\`. Use a path like ` +
        `'data.${field}' if you really meant a nested data field.`,
      'INVALID_QUERY',
    );
  }
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Lazily loaded Pipelines module. Same lazy-import pattern as
 * `pipeline-adapter.ts`: avoids pulling pipeline-related code at module
 * load for callers that never invoke FTS.
 */
let _Pipelines: typeof Pipelines | null = null;

async function getPipelines(): Promise<typeof Pipelines> {
  if (!_Pipelines) {
    const mod = await import('@google-cloud/firestore');
    _Pipelines = mod.Pipelines;
  }
  return _Pipelines;
}

/**
 * Run a full-text search against a collection path. Returns the
 * matching records as `StoredGraphRecord[]`, ordered by relevance
 * (the search index's natural score order — highest-first).
 *
 * Validation surface:
 *
 *   - `query` must be a non-empty string.
 *   - Each entry in `fields` (if set) must not be an envelope field
 *     and is rewritten to `data.<name>` for bare names.
 *   - `limit` must be a positive integer.
 *
 * Note: scan-protection lives in the client wrapper (same as
 * `findNearest`). Backends never see whether the caller opted in via
 * `allowCollectionScan` — that flag is consumed before dispatch.
 */
export async function runFirestoreFullTextSearch(
  db: Firestore,
  collectionPath: string,
  params: FullTextSearchParams,
): Promise<StoredGraphRecord[]> {
  if (typeof params.query !== 'string' || params.query.length === 0) {
    throw new FiregraphError(
      'fullTextSearch(): query must be a non-empty string.',
      'INVALID_QUERY',
    );
  }
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new FiregraphError(
      `fullTextSearch(): limit must be a positive integer (got ${params.limit}).`,
      'INVALID_QUERY',
    );
  }

  // Normalise field paths up front so any envelope-field misuse fails
  // before we hit the SDK.
  const normalizedFields = params.fields?.map((f) => normalizeFullTextFieldPath(f));

  const P = await getPipelines();

  // Build the search-stage query expression.
  //
  // - When `fields` is omitted, `documentMatches(query)` searches every
  //   indexed search field on the document (the SDK's default).
  // - When `fields` is set, we currently still pass `documentMatches(query)`
  //   without per-field scoping. The 8.5.0 typed surface does NOT expose
  //   a per-field text predicate (the commented-out `matches(field, query)`
  //   in the d.ts is gated on a future backend feature). When that
  //   ships, swap in `and(matches(f1, query), matches(f2, query), ...)` —
  //   the `normalizedFields` validation already enforces the field list
  //   so wiring is additive.
  const searchQuery = P.documentMatches(params.query);

  // Build the search stage. Sort by relevance score descending — that's
  // the standard FTS contract.
  let pipeline = db.pipeline().collection(collectionPath).search({
    query: searchQuery,
    sort: P.score().descending(),
  });

  // Identifying filters land *after* `search()` because the search
  // stage must be the first stage of a pipeline. The post-search
  // `where` doesn't shrink the index walk — it's a safety net. For
  // efficient per-aType search, rely on Firestore's per-collection
  // FTS indexes.
  const whereExprs: Pipelines.BooleanExpression[] = [];
  if (params.aType) whereExprs.push(P.equal('aType', params.aType));
  if (params.axbType) whereExprs.push(P.equal('axbType', params.axbType));
  if (params.bType) whereExprs.push(P.equal('bType', params.bType));
  if (whereExprs.length === 1) {
    pipeline = pipeline.where(whereExprs[0]);
  } else if (whereExprs.length > 1) {
    const [first, second, ...rest] = whereExprs;
    pipeline = pipeline.where(P.and(first, second, ...rest));
  }

  pipeline = pipeline.limit(params.limit);

  // Reference normalizedFields so the unused-when-empty `fields`
  // validation cost still happens. Once per-field text predicates ship
  // upstream, this becomes the input to `matches(...)` calls.
  void normalizedFields;

  const snap = await pipeline.execute();
  return snap.results.map((r) => r.data() as StoredGraphRecord);
}
