/**
 * Shared classic-API multi-source fan-out for Firestore.
 *
 * Used by:
 *
 *   - `firestore-standard` (always — Standard has no Pipelines path).
 *   - `firestore-enterprise` (only when `queryMode === 'classic'`, i.e.
 *     under the emulator or when explicitly forced).
 *
 * Strategy: chunk `params.sources` into 30-element groups (the classic
 * `'in'` operator's documented cap), dispatch one `Query.where(field, 'in',
 * chunk)` per chunk in parallel via `Promise.all`, then concat. Optional
 * post-pass sort + total-limit cap so observable behaviour matches the
 * SQL backends' single-statement `WHERE … IN (?,?,…) ORDER BY … LIMIT N`.
 *
 * Why this is still a win over the per-source `findEdges` loop in
 * `traverse.ts`: that loop emits one query per source UID. With 100
 * sources it's 100 round trips. The chunked path is `ceil(100/30) = 4`
 * round trips. The Pipelines `equalAny` path (Enterprise) collapses all
 * 100 into one — see `firestore-expand.ts` — but Standard can't reach
 * that, so chunked classic is the best Standard can do.
 *
 * Hydration follows the same chunking strategy: a single classic query
 * per chunk that fetches every node row whose `aUid` is in the chunk
 * (nodes are stored as self-loops `(uid, 'is', uid)` so `aUid IN chunk`
 * picks them up). Document IDs would also work via per-UID `getDoc`,
 * but that's N round trips for N targets — chunking matches the
 * fan-out path's round-trip count.
 */

import { FiregraphError } from '../errors.js';
import type { ExpandParams, ExpandResult, QueryFilter, StoredGraphRecord } from '../types.js';
import { NODE_RELATION } from './constants.js';
import type { FirestoreAdapter } from './firestore-classic-adapter.js';

/**
 * Maximum elements per Firestore classic `'in'` operator. Documented as 30
 * across the Node Admin SDK, Firestore web SDK, and the security-rules
 * runtime. Exceeding this throws `INVALID_ARGUMENT` on the wire.
 */
export const FIRESTORE_CLASSIC_IN_CHUNK_SIZE = 30;

/**
 * Read a (possibly dotted) field from a record. Used for the post-concat
 * sort pass. Mirrors the dotted-path resolution in
 * `firestore-projection.ts` but read-only and without bare-name rewriting
 * — `ExpandParams.orderBy.field` is always a fully-qualified path.
 */
function readField(record: StoredGraphRecord, path: string): unknown {
  if (!path.includes('.')) {
    return (record as unknown as Record<string, unknown>)[path];
  }
  let cursor: unknown = record;
  for (const seg of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Compare two field values for a stable, total ordering. Mirrors
 * Firestore's classic-API ordering semantics: numbers numerically,
 * strings lexicographically, booleans (false < true), and nullish goes
 * first. Mixed-type comparisons fall back to `String(...)` so the sort is
 * defined for every input shape — the alternative would be the JS
 * default `<` semantics, which silently coerce and lose stability.
 */
function compareFieldValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === tb) {
    // `a` and `b` share a primitive type (number, string, boolean, etc.);
    // a direct `<` comparison is safe under the JS comparison rules. Cast
    // through `string` solely to satisfy TS's `unknown < unknown` ban —
    // the runtime behaviour is identical for any pair of same-type
    // primitives.
    return (a as string) < (b as string) ? -1 : 1;
  }
  // Mixed types — fall back to string comparison.
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Run a classic-API `expand()` against a Firestore collection via the
 * supplied `FirestoreAdapter`. Returns the same `ExpandResult` shape as
 * the SQL backends.
 *
 * Empty `params.sources` short-circuits to an empty result without
 * touching the adapter — the chunking pass would emit zero queries
 * anyway, but the early return makes the contract explicit and matches
 * the `client.expand` wrapper.
 *
 * Self-loop guard: when `params.axbType === NODE_RELATION`, edges where
 * `aUid === bUid` are node rows, not real hops. The SQL backends filter
 * those out via `aUid != bUid`; we mirror the same filter as a
 * post-process pass because Firestore classic queries don't support
 * column-vs-column predicates. The guard is defensive — `traverse.ts`
 * never sends `NODE_RELATION` as `axbType`, but a direct
 * `client.expand({ axbType: 'is' })` call would otherwise return the
 * source nodes themselves.
 */
export async function runFirestoreClassicExpand(
  adapter: FirestoreAdapter,
  params: ExpandParams,
): Promise<ExpandResult> {
  if (params.sources.length === 0) {
    return params.hydrate ? { edges: [], targets: [] } : { edges: [] };
  }

  if (params.axbType.length === 0) {
    throw new FiregraphError('expand(): axbType must be a non-empty string.', 'INVALID_QUERY');
  }

  const direction = params.direction ?? 'forward';
  const sourceField = direction === 'forward' ? 'aUid' : 'bUid';

  const chunks = chunkUids(params.sources, FIRESTORE_CLASSIC_IN_CHUNK_SIZE);
  const totalLimit =
    params.limitPerSource !== undefined ? params.sources.length * params.limitPerSource : undefined;

  const buildFilters = (chunk: string[]): QueryFilter[] => {
    const filters: QueryFilter[] = [
      { field: 'axbType', op: '==', value: params.axbType },
      { field: sourceField, op: 'in', value: chunk },
    ];
    if (params.aType !== undefined) {
      filters.push({ field: 'aType', op: '==', value: params.aType });
    }
    if (params.bType !== undefined) {
      filters.push({ field: 'bType', op: '==', value: params.bType });
    }
    return filters;
  };

  const buildOptions = (chunk: string[]) => {
    const opts: { orderBy?: ExpandParams['orderBy']; limit?: number } = {};
    if (params.orderBy) opts.orderBy = params.orderBy;
    if (params.limitPerSource !== undefined) {
      // Per-chunk soft cap: chunk.length * limitPerSource. The post-concat
      // slice enforces the global cap.
      opts.limit = chunk.length * params.limitPerSource;
    }
    return opts;
  };

  const chunkResults = await Promise.all(
    chunks.map((chunk) => adapter.query(buildFilters(chunk), buildOptions(chunk))),
  );
  let edges: StoredGraphRecord[] = chunkResults.flat();

  // Self-loop filter when the caller targeted the node-relation. See JSDoc.
  if (params.axbType === NODE_RELATION) {
    edges = edges.filter((e) => e.aUid !== e.bUid);
  }

  // Cross-chunk ordering pass. Each chunk's result is already sorted (we
  // pushed `orderBy` into the per-chunk query), but concat'd order is not
  // globally sorted. Re-sort to honour the contract.
  if (params.orderBy) {
    const sortField = params.orderBy.field;
    const dir = params.orderBy.direction ?? 'asc';
    edges.sort((a, b) => {
      const cmp = compareFieldValues(readField(a, sortField), readField(b, sortField));
      return dir === 'asc' ? cmp : -cmp;
    });
  }
  if (totalLimit !== undefined && edges.length > totalLimit) {
    edges = edges.slice(0, totalLimit);
  }

  if (!params.hydrate) return { edges };

  // Hydration: fetch every target node by `aUid in chunk` against the
  // node-relation. Nodes are self-loops, so this picks up exactly one row
  // per UID. Chunked the same way as the fan-out queries above.
  const targetUids = edges.map((e) => (direction === 'forward' ? e.bUid : e.aUid));
  const uniqueTargets = [...new Set(targetUids)];
  if (uniqueTargets.length === 0) {
    return { edges, targets: [] };
  }
  const hydrateChunks = chunkUids(uniqueTargets, FIRESTORE_CLASSIC_IN_CHUNK_SIZE);
  const hydrateResults = await Promise.all(
    hydrateChunks.map((chunk) =>
      adapter.query([
        { field: 'axbType', op: '==', value: NODE_RELATION },
        { field: 'aUid', op: 'in', value: chunk },
      ]),
    ),
  );
  const byUid = new Map<string, StoredGraphRecord>();
  for (const row of hydrateResults.flat()) {
    // `bUid === aUid === uid` for node rows by construction.
    byUid.set(row.bUid, row);
  }
  const targets = targetUids.map((uid) => byUid.get(uid) ?? null);
  return { edges, targets };
}

/** Split a list into fixed-size chunks. Exported for the unit test. */
export function chunkUids(uids: readonly string[], chunkSize: number): string[][] {
  if (chunkSize <= 0) {
    throw new FiregraphError(
      `chunkUids: chunkSize must be positive (got ${chunkSize}).`,
      'INVALID_QUERY',
    );
  }
  const out: string[][] = [];
  for (let i = 0; i < uids.length; i += chunkSize) {
    out.push(uids.slice(i, i + chunkSize) as string[]);
  }
  return out;
}
