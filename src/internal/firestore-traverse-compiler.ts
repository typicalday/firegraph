/**
 * Pure compiler for engine-level multi-hop traversal.
 *
 * Takes an `EngineTraversalParams` spec and decides whether it can be
 * compiled into one nested-Pipeline round trip. Returns a discriminated
 * union — `{ eligible: true; normalized }` carries the validated spec
 * with defaults filled in; `{ eligible: false; reason }` carries a
 * human-readable explanation that the caller (traversal layer or
 * `engineTraversal: 'force'` test path) can either log, throw, or
 * silently fall back on.
 *
 * The compiler is split out so the validation surface is unit-testable
 * without spinning up a Firestore SDK or a real Pipeline. The actual
 * pipeline construction and result decoding live in
 * `firestore-traverse.ts` and depend on `@google-cloud/firestore`.
 *
 * Eligibility checks (in order):
 *
 *   1. `hops.length` ≥ 1                                  → otherwise no traversal to run
 *   2. `hops.length` ≤ `maxDepth` (default 5)             → pipeline-depth cap
 *   3. Every hop has `limitPerSource` set                 → required to bound response size
 *   4. Every hop's `axbType` is non-empty                 → query needs a relation predicate
 *   5. Worst-case response size ≤ `maxReads` budget       → prevent runaway tree responses
 *
 * The maxDepth bound is conservative — Firestore Pipelines don't
 * publish a hard limit on `addFields` / `define` nesting depth, but
 * empirically deep nesting starts to slow down planning. Five hops
 * covers the vast majority of real-world traversal specs; specs that
 * exceed it fall back to the per-hop loop with a debug-level signal.
 *
 * The response-size estimate is the conservative top-line:
 * `sources.length × Π(limitPerSource_i)`. This is the worst-case edge
 * count at the deepest hop, which dominates the total tree size for
 * branching factors > 1. We deliberately don't sum over hops — the
 * deepest-hop bound already triggers fallback well before any realistic
 * total response size matters.
 */

import type { EngineHopSpec, EngineTraversalParams } from '../types.js';

/**
 * Default cap on `addFields` / `define` nesting depth. Traversal specs
 * deeper than this are rejected by the compiler and fall back to the
 * per-hop loop. Configurable per call via `compileEngineTraversal`'s
 * `opts.maxDepth`.
 */
export const MAX_PIPELINE_DEPTH = 5;

/**
 * A normalized, validated engine-traversal spec ready for the executor
 * to translate into a nested Pipeline. Mirrors `EngineTraversalParams`
 * but with `direction` defaulted to `'forward'` on every hop and the
 * estimated worst-case response size attached for budget bookkeeping.
 */
export interface NormalizedEngineTraversal {
  sources: string[];
  hops: Array<
    Required<Pick<EngineHopSpec, 'axbType' | 'limitPerSource' | 'direction'>> & EngineHopSpec
  >;
  /** Worst-case edge count at the deepest hop — `sources.length × Π(limitPerSource_i)`. */
  estimatedReads: number;
}

export type CompilerResult =
  | { eligible: true; normalized: NormalizedEngineTraversal }
  | { eligible: false; reason: string };

export interface CompilerOptions {
  /** Override the depth cap. Default `MAX_PIPELINE_DEPTH` (5). */
  maxDepth?: number;
  /**
   * Worst-case response-size budget. The compiler refuses to emit when
   * `sources.length × Π(limitPerSource_i)` exceeds this. The traversal
   * layer threads its own `maxReads` through — engine traversal counts
   * as one round trip but its tree response can return many docs.
   */
  maxReads?: number;
}

/**
 * Validate an engine-traversal spec. Pure; no SDK interaction.
 *
 * Returns `{ eligible: true; normalized }` with `direction` defaulted
 * and `estimatedReads` attached, or `{ eligible: false; reason }` with
 * a one-line description suitable for logging or for an
 * `UNSUPPORTED_OPERATION` error message.
 */
export function compileEngineTraversal(
  params: EngineTraversalParams,
  opts?: CompilerOptions,
): CompilerResult {
  const maxDepth = opts?.maxDepth ?? MAX_PIPELINE_DEPTH;
  const maxReads = opts?.maxReads ?? params.maxReads;

  if (!Array.isArray(params.hops) || params.hops.length === 0) {
    return { eligible: false, reason: 'engine traversal requires at least one hop' };
  }
  if (params.hops.length > maxDepth) {
    return {
      eligible: false,
      reason: `engine traversal depth ${params.hops.length} exceeds MAX_PIPELINE_DEPTH (${maxDepth})`,
    };
  }
  if (!Array.isArray(params.sources)) {
    return { eligible: false, reason: 'engine traversal requires a sources array' };
  }

  const normalizedHops: NormalizedEngineTraversal['hops'] = [];
  for (let i = 0; i < params.hops.length; i++) {
    const hop = params.hops[i];
    if (!hop.axbType || hop.axbType.length === 0) {
      return {
        eligible: false,
        reason: `engine traversal hop ${i} is missing axbType`,
      };
    }
    if (
      typeof hop.limitPerSource !== 'number' ||
      hop.limitPerSource <= 0 ||
      !Number.isFinite(hop.limitPerSource)
    ) {
      return {
        eligible: false,
        reason: `engine traversal hop ${i} (${hop.axbType}) requires a positive limitPerSource`,
      };
    }
    normalizedHops.push({
      ...hop,
      axbType: hop.axbType,
      direction: hop.direction ?? 'forward',
      limitPerSource: hop.limitPerSource,
    });
  }

  // Worst-case at deepest hop. We multiply iteratively so that an
  // overflowing product short-circuits before bumping into JS's float
  // precision. `Number.MAX_SAFE_INTEGER` is well past any reasonable
  // `maxReads` value, so that's the early-exit threshold even when the
  // caller didn't supply a budget.
  let estimatedReads = Math.max(1, params.sources.length);
  for (const hop of normalizedHops) {
    estimatedReads *= hop.limitPerSource;
    if (estimatedReads > Number.MAX_SAFE_INTEGER) {
      estimatedReads = Number.MAX_SAFE_INTEGER;
      break;
    }
  }

  if (maxReads !== undefined && estimatedReads > maxReads) {
    return {
      eligible: false,
      reason: `engine traversal worst-case response size ${estimatedReads} exceeds maxReads budget ${maxReads}`,
    };
  }

  return {
    eligible: true,
    normalized: {
      sources: params.sources,
      hops: normalizedHops,
      estimatedReads,
    },
  };
}
