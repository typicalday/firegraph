/**
 * Engine-level multi-hop traversal executor for Firestore Enterprise.
 *
 * Compiles an `EngineTraversalParams` spec into one nested Pipeline
 * (`define` + `addFields(child.toArrayExpression().as(...))`) and
 * dispatches a single round trip. The single-call collapse is the
 * payoff that motivates the `traversal.serverSide` capability — a
 * 5-hop traversal with a 100-element fan-out at hop 1 stays at one
 * server-side call instead of fanning out 100 round trips per
 * subsequent hop.
 *
 * The executor is a thin shell over `compileEngineTraversal` (validation
 * lives in `firestore-traverse-compiler.ts`) and the typed Pipelines
 * surface in `@google-cloud/firestore@8.5.0`. Every primitive used
 * (`define`, `addFields`, `field`, `variable`, `equal`, `equalAny`,
 * `and`, `toArrayExpression`) is GA-typed in 8.5.0 — no `@beta`
 * annotation, so this capability does NOT need a `previewDml`-style
 * opt-in flag (unlike `query.dml` in Phase 13b).
 *
 * Pipeline shape (forward 2-hop):
 *
 * ```
 * db.pipeline().collection(graph)
 *   .where(and(equal('axbType', 'e1'), equalAny('aUid', sources)))
 *   .define(field('bUid').as('hop_0_bUid'))
 *   .addFields(
 *     db.pipeline().collection(graph)
 *       .where(and(equal('axbType', 'e2'), equal('aUid', variable('hop_0_bUid'))))
 *       .toArrayExpression()
 *       .as('hop_1'))
 *   .execute();
 * ```
 *
 * Each top-level result row is a hop-0 edge augmented with a `hop_1`
 * field — an array of hop-1 edges. For depth N+1 the executor wraps
 * the inner pipeline in another `define` + `addFields` layer before
 * `toArrayExpression()`, with each hop's sub-pipeline nested inside
 * the previous hop's `addFields(...)`.
 *
 * The reverse-direction mode swaps the join key — it uses
 * `equalAny('bUid', sources)` at the root and `field('aUid').as(...)`
 * for the variable bound at each depth. Mixed directions across hops
 * are honoured per-hop.
 *
 * Result decoding flattens the tree into per-depth `StoredGraphRecord[]`
 * arrays, deduping each depth on the target-side UID (`bUid` for
 * forward hops, `aUid` for reverse). The sub-array fields (`hop_1`,
 * `hop_2`, …) are stripped from each row before it lands in the
 * returned `edges` slot — they're scaffolding, not part of the edge
 * payload.
 *
 * NODE_RELATION self-loop guard mirrors `firestore-expand.ts`: if any
 * hop targets `axbType === 'is'`, post-pass-filter rows where
 * `aUid === bUid`. Defensive — `traverse.ts` never emits the
 * node-relation as a hop axbType — but matches the parity story for
 * `expand()`.
 */

import type { Firestore, Pipelines } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { EngineTraversalParams, EngineTraversalResult, StoredGraphRecord } from '../types.js';
import { NODE_RELATION } from './constants.js';
import {
  compileEngineTraversal,
  type NormalizedEngineTraversal,
} from './firestore-traverse-compiler.js';

/**
 * Field name on each parent row holding the array of child-hop edges.
 * The depth index is appended (`hop_0_children`, `hop_1_children`, …)
 * so deeply-nested rows carry distinguishable scaffolding fields the
 * decoder can strip cleanly.
 */
function childArrayKey(depth: number): string {
  return `hop_${depth}_children`;
}

/**
 * Variable name for the join key bound at a given depth via `define()`.
 * Forward hops bind `bUid`; reverse hops bind `aUid`. The depth index
 * appears in the variable name to prevent collisions when nested
 * pipelines need to refer to multiple ancestors.
 */
function joinVarName(depth: number): string {
  return `hop_${depth}_join`;
}

/**
 * Lazily loaded Pipelines module. Same lazy-import pattern as
 * `firestore-expand.ts` and the FTS / geo helpers — avoids pulling
 * pipeline code into the module load for callers that never invoke
 * engine traversal.
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
 * Build a single `BooleanExpression` from the per-hop predicate set.
 * `aType` / `bType` filters are optional and only added when set.
 *
 * The first hop's source-side predicate uses `equalAny(field, sources)`
 * (multi-source fan-out); deeper hops use `equal(field, variable(...))`
 * to pin against the bound join key from the parent define stage.
 */
function buildHopPredicates(
  P: typeof Pipelines,
  hop: NormalizedEngineTraversal['hops'][number],
  sourcePredicate: Pipelines.BooleanExpression,
): Pipelines.BooleanExpression {
  const exprs: Pipelines.BooleanExpression[] = [P.equal('axbType', hop.axbType), sourcePredicate];
  if (hop.aType !== undefined) exprs.push(P.equal('aType', hop.aType));
  if (hop.bType !== undefined) exprs.push(P.equal('bType', hop.bType));

  const [first, second, ...rest] = exprs;
  return P.and(first, second, ...rest);
}

/**
 * Apply `orderBy` + `limit` to a hop's pipeline.
 *
 * `limitPerSource` translates to a per-pipeline `limit` on the
 * sub-pipeline (one nested pipeline per source row). For the root
 * pipeline it's `sources.length × limitPerSource` to mirror
 * `firestore-expand.ts`'s contract.
 */
function applyHopOrderingAndLimit(
  P: typeof Pipelines,
  pipeline: Pipelines.Pipeline,
  hop: NormalizedEngineTraversal['hops'][number],
  totalLimit: number,
): Pipelines.Pipeline {
  let p = pipeline;
  if (hop.orderBy) {
    const f = P.field(hop.orderBy.field);
    const ordering = hop.orderBy.direction === 'desc' ? f.descending() : f.ascending();
    p = p.sort(ordering);
  }
  p = p.limit(totalLimit);
  return p;
}

/**
 * Build the inner-most-to-outer-most chain of pipelines for hops at
 * depth ≥ 1. The deepest hop's pipeline has no children; each
 * shallower hop wraps the deeper-hop pipeline in
 * `addFields(child.toArrayExpression().as(...))`.
 *
 * The returned pipeline is bound to a variable at the parent depth,
 * so it does NOT itself include the source-side `equalAny`. Instead
 * the source-side predicate is `equal(field('aUid'), variable('hop_{parentDepth}_join'))`
 * (or `bUid` for reverse).
 */
function buildSubPipeline(
  P: typeof Pipelines,
  db: Firestore,
  collectionPath: string,
  hops: NormalizedEngineTraversal['hops'],
  depth: number,
): Pipelines.Pipeline {
  const hop = hops[depth];
  const parentDepth = depth - 1;
  const sourceField = hop.direction === 'forward' ? 'aUid' : 'bUid';

  const sourcePredicate: Pipelines.BooleanExpression = P.equal(
    sourceField,
    P.variable(joinVarName(parentDepth)),
  );
  const where = buildHopPredicates(P, hop, sourcePredicate);

  let pipeline = db.pipeline().collection(collectionPath).where(where);
  // limitPerSource × 1 (one source per nested pipeline invocation, since
  // we're already pinned to a single ancestor variable).
  pipeline = applyHopOrderingAndLimit(P, pipeline, hop, hop.limitPerSource);

  // If there's a deeper hop, bind this hop's join key and addFields the
  // child pipeline as an array expression.
  if (depth + 1 < hops.length) {
    const targetField = hop.direction === 'forward' ? 'bUid' : 'aUid';
    pipeline = pipeline.define(P.field(targetField).as(joinVarName(depth)));
    const child = buildSubPipeline(P, db, collectionPath, hops, depth + 1);
    pipeline = pipeline.addFields(child.toArrayExpression().as(childArrayKey(depth)));
  }

  return pipeline;
}

/**
 * Build the full nested pipeline for an engine-traversal call.
 *
 * The root pipeline does the multi-source fan-out via
 * `equalAny('aUid', sources)` (forward) or `equalAny('bUid', sources)`
 * (reverse). Subsequent hops are wrapped via `addFields` recursively.
 */
function buildRootPipeline(
  P: typeof Pipelines,
  db: Firestore,
  collectionPath: string,
  spec: NormalizedEngineTraversal,
): Pipelines.Pipeline {
  const hop0 = spec.hops[0];
  const sourceField = hop0.direction === 'forward' ? 'aUid' : 'bUid';
  const sourcePredicate: Pipelines.BooleanExpression = P.equalAny(
    sourceField,
    spec.sources as Array<unknown>,
  );
  const where = buildHopPredicates(P, hop0, sourcePredicate);

  let pipeline = db.pipeline().collection(collectionPath).where(where);
  pipeline = applyHopOrderingAndLimit(P, pipeline, hop0, spec.sources.length * hop0.limitPerSource);

  if (spec.hops.length > 1) {
    const targetField = hop0.direction === 'forward' ? 'bUid' : 'aUid';
    pipeline = pipeline.define(P.field(targetField).as(joinVarName(0)));
    const child = buildSubPipeline(P, db, collectionPath, spec.hops, 1);
    pipeline = pipeline.addFields(child.toArrayExpression().as(childArrayKey(0)));
  }

  return pipeline;
}

/**
 * Strip the engine-traversal scaffolding from one decoded row,
 * yielding a clean `StoredGraphRecord` whose shape matches what
 * `findEdges` and `expand` return.
 *
 * The scaffolding is the `hop_{depth}_children` field for the depth
 * the row is at. Removing only the per-depth child-array key (instead
 * of every `hop_*` key) lets us layer scaffolding from multiple
 * ancestors without overwriting each other.
 */
function stripScaffolding(row: Record<string, unknown>, depth: number): StoredGraphRecord {
  const stripped: Record<string, unknown> = { ...row };
  delete stripped[childArrayKey(depth)];
  // Cast through `unknown` because `StoredGraphRecord` declares specific
  // required fields (`aType`, `aUid`, …) and TS won't narrow a generic
  // object with an index signature down to that nominal shape. The row
  // came from `pipeline.execute()` which uses `data()` on the result —
  // by construction it has the envelope fields the storage backend wrote.
  return stripped as unknown as StoredGraphRecord;
}

/**
 * Decode the nested-pipeline tree into per-depth `StoredGraphRecord[]`
 * arrays, deduped on the target-side UID.
 *
 * For each depth, the dedup key is `bUid` (forward) or `aUid`
 * (reverse). Ordering is preserved: the first occurrence of a UID
 * wins, matching `traverse.ts`'s existing dedup semantics.
 */
function decodeTree(
  rootRows: Array<Record<string, unknown>>,
  hops: NormalizedEngineTraversal['hops'],
): EngineTraversalResult {
  const out: EngineTraversalResult['hops'] = [];
  let frontier: Array<Record<string, unknown>> = rootRows;

  for (let depth = 0; depth < hops.length; depth++) {
    const hop = hops[depth];
    const targetField = hop.direction === 'forward' ? 'bUid' : 'aUid';

    const seen = new Set<string>();
    const edges: StoredGraphRecord[] = [];
    const nextFrontier: Array<Record<string, unknown>> = [];

    for (const row of frontier) {
      // Children for the next depth are stored under `hop_{depth}_children`
      // on this row. Pull them BEFORE we strip scaffolding from the row.
      const childKey = childArrayKey(depth);
      const children = row[childKey];
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child && typeof child === 'object') {
            nextFrontier.push(child as Record<string, unknown>);
          }
        }
      }

      const stripped = stripScaffolding(row, depth);
      // Self-loop guard for the node-relation. `traverse.ts` never sends
      // it through engine traversal, but mirror `firestore-expand.ts`'s
      // post-pass for parity.
      if (hop.axbType === NODE_RELATION && stripped.aUid === stripped.bUid) continue;

      const dedupKey = (stripped as unknown as Record<string, unknown>)[targetField];
      if (typeof dedupKey !== 'string' || seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      edges.push(stripped);
    }

    out.push({ edges, sourceCount: depth === 0 ? -1 : out[depth - 1].edges.length });
    frontier = nextFrontier;
  }

  // Patch sourceCount: depth 0's count is the input source count, which
  // we don't have in this scope — the caller fills it in below from
  // `spec.sources.length`. Leaving -1 here lets the caller override
  // without scanning the structure twice.
  return {
    hops: out,
    totalReads: 1,
  };
}

/**
 * Top-level entry point. Validates the spec, builds the nested
 * pipeline, dispatches one round trip, and decodes the result.
 *
 * Throws `FiregraphError('UNSUPPORTED_OPERATION')` when the compiler
 * rejects the spec — the traversal layer's `engineTraversal: 'auto'`
 * default never reaches this code path with an ineligible spec
 * (eligibility is pre-checked), but `'force'` mode does, and a thrown
 * error is the right signal for that path.
 */
export async function runFirestoreEngineTraversal(
  db: Firestore,
  collectionPath: string,
  params: EngineTraversalParams,
): Promise<EngineTraversalResult> {
  const compiled = compileEngineTraversal(params);
  if (!compiled.eligible) {
    throw new FiregraphError(
      `engine traversal not eligible: ${compiled.reason}`,
      'UNSUPPORTED_OPERATION',
    );
  }
  const spec = compiled.normalized;

  if (spec.sources.length === 0) {
    return {
      hops: spec.hops.map(() => ({ edges: [], sourceCount: 0 })),
      totalReads: 0,
    };
  }

  const P = await getPipelines();
  const pipeline = buildRootPipeline(P, db, collectionPath, spec);
  const snap = await pipeline.execute();
  const rows = snap.results.map((r) => r.data() as Record<string, unknown>);

  const result = decodeTree(rows, spec.hops);
  // Patch hop[0].sourceCount with the input source count (the decoder
  // doesn't have visibility into the original `spec.sources` length).
  if (result.hops.length > 0) {
    result.hops[0] = { ...result.hops[0], sourceCount: spec.sources.length };
  }
  return result;
}
