/**
 * Shared Pipelines-API multi-source fan-out for Firestore Enterprise.
 *
 * Translates an `expand({ sources, axbType, ... })` call into a single
 * `db.pipeline().collection(path).where(equalAny(sourceField, sources))
 * .sort(...).limit(...).execute()` pipeline and decodes the result.
 * Used only by `firestore-enterprise` when `queryMode === 'pipeline'`.
 * The classic-mode (and Standard) path uses the chunked-`'in'` helper in
 * `firestore-classic-expand.ts`.
 *
 * Why this matters: the classic Query API caps `'in'` operators at 30
 * elements, forcing a `ceil(N/30)` round-trip fan-out per call. Pipeline
 * `equalAny(field, values)` is one server-side stage with no documented
 * cap on the value list — `Pipelines` accepts an arbitrary array. With
 * 1,000 sources, classic does ~34 round trips; pipelines do one. This is
 * the engine-level collapse that makes single-hop fan-out tractable on
 * Enterprise without changing the public `expand()` contract.
 *
 * Hydration follows the same one-pipeline shape: a second pipeline that
 * fetches every node row whose `aUid` is in the deduped target set
 * (nodes are stored as self-loops `(uid, 'is', uid)`, so `aUid` and
 * `bUid` both equal the node UID by construction).
 *
 * Self-loop guard: when `params.axbType === NODE_RELATION`, edges where
 * `aUid === bUid` are nodes, not real hops. We mirror the
 * `firestore-classic-expand.ts` post-process filter rather than try to
 * express `aUid != bUid` as a typed pipeline expression — the typed
 * surface in 8.5.0 doesn't expose column-vs-column predicates, so a
 * post-pass is the clean path. The guard is defensive; `traverse.ts`
 * never sends `NODE_RELATION` as `axbType`.
 */

import type { Firestore, Pipelines } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { ExpandParams, ExpandResult, StoredGraphRecord } from '../types.js';
import { NODE_RELATION } from './constants.js';

/**
 * Lazily loaded Pipelines module. Same lazy-import pattern as
 * `pipeline-adapter.ts` and `firestore-fulltext.ts`: avoids pulling
 * pipeline-related code at module load for callers that never invoke
 * `expand()` on Enterprise.
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
 * Run a Pipelines-API `expand()` against a Firestore collection.
 * Returns the same `ExpandResult` shape as the SQL backends and the
 * classic-mode helper.
 *
 * Empty `params.sources` short-circuits without touching the SDK — the
 * pipeline would emit an empty `equalAny([])` which the SDK accepts but
 * the early return makes the contract explicit and matches the
 * `client.expand` wrapper.
 */
export async function runFirestorePipelineExpand(
  db: Firestore,
  collectionPath: string,
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

  const P = await getPipelines();

  // Build the AND predicate. `equalAny(field, values)` is the typed
  // pipeline equivalent of classic's `'in'` operator, but without the
  // 30-element cap.
  const exprs: Pipelines.BooleanExpression[] = [
    P.equal('axbType', params.axbType),
    P.equalAny(sourceField, params.sources as Array<unknown>),
  ];
  if (params.aType !== undefined) exprs.push(P.equal('aType', params.aType));
  if (params.bType !== undefined) exprs.push(P.equal('bType', params.bType));

  let pipeline = db.pipeline().collection(collectionPath);
  if (exprs.length === 1) {
    pipeline = pipeline.where(exprs[0]);
  } else {
    const [first, second, ...rest] = exprs;
    pipeline = pipeline.where(P.and(first, second, ...rest));
  }

  if (params.orderBy) {
    const f = P.field(params.orderBy.field);
    const ordering = params.orderBy.direction === 'desc' ? f.descending() : f.ascending();
    pipeline = pipeline.sort(ordering);
  }

  // Apply the global limit server-side. Unlike the chunked classic path
  // we don't need a per-chunk soft cap — there's only one round trip.
  // `limitPerSource * sources.length` is the documented contract for
  // the cross-chunk total cap; mirror it here.
  const totalLimit =
    params.limitPerSource !== undefined ? params.sources.length * params.limitPerSource : undefined;
  if (totalLimit !== undefined) {
    pipeline = pipeline.limit(totalLimit);
  }

  const snap = await pipeline.execute();
  let edges: StoredGraphRecord[] = snap.results.map((r) => r.data() as StoredGraphRecord);

  // Self-loop filter when the caller targeted the node-relation. See JSDoc.
  if (params.axbType === NODE_RELATION) {
    edges = edges.filter((e) => e.aUid !== e.bUid);
  }

  if (!params.hydrate) return { edges };

  // Hydration: one pipeline that fetches every target node by
  // `axbType == NODE_RELATION AND aUid equalAny <targets>`. Nodes are
  // self-loops so this picks up exactly one row per UID.
  const targetUids = edges.map((e) => (direction === 'forward' ? e.bUid : e.aUid));
  const uniqueTargets = [...new Set(targetUids)];
  if (uniqueTargets.length === 0) {
    return { edges, targets: [] };
  }

  const hydratePipeline = db
    .pipeline()
    .collection(collectionPath)
    .where(
      P.and(P.equal('axbType', NODE_RELATION), P.equalAny('aUid', uniqueTargets as Array<unknown>)),
    );

  const hydrateSnap = await hydratePipeline.execute();
  const byUid = new Map<string, StoredGraphRecord>();
  for (const r of hydrateSnap.results) {
    const row = r.data() as StoredGraphRecord;
    // `bUid === aUid === uid` for node rows by construction.
    byUid.set(row.bUid, row);
  }
  const targets = targetUids.map((uid) => byUid.get(uid) ?? null);
  return { edges, targets };
}
