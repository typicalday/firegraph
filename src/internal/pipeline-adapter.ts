/**
 * Pipeline query adapter — translates QueryFilter[] to Firestore Pipeline
 * expressions and executes them via db.pipeline().
 *
 * Only handles query() — doc-level operations (get/set/update/delete) stay
 * on the standard FirestoreAdapter.
 */
import type { Firestore, Pipelines } from '@google-cloud/firestore';

import type { QueryFilter, QueryOptions, StoredGraphRecord } from '../types.js';

/**
 * Minimal interface for the Pipeline query adapter.
 * Only implements the query path — doc operations are handled by FirestoreAdapter.
 */
export interface PipelineQueryAdapter {
  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]>;
}

/**
 * Lazily loaded Pipelines module. We use dynamic import so that standard-mode
 * users (and the emulator) don't pull in pipeline-related code at module load.
 */
let _Pipelines: typeof Pipelines | null = null;

async function getPipelines(): Promise<typeof Pipelines> {
  if (!_Pipelines) {
    const mod = await import('@google-cloud/firestore');
    _Pipelines = mod.Pipelines;
  }
  return _Pipelines;
}

type PipelinesType = typeof Pipelines;
type BooleanExpr = Pipelines.BooleanExpression;

/**
 * Maps a QueryFilter to a Pipeline BooleanExpression.
 *
 * Uses the string-based overloads (e.g. `equal(fieldName, value)`) which
 * accept `unknown` values, avoiding type issues with `constant()` overloads.
 */
function buildFilterExpression(P: PipelinesType, filter: QueryFilter): BooleanExpr {
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
      throw new Error(`Unsupported filter op for pipeline mode: ${op}`);
  }
}

export function createPipelineQueryAdapter(
  db: Firestore,
  collectionPath: string,
): PipelineQueryAdapter {
  return {
    async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
      const P = await getPipelines();

      // Build pipeline
      let pipeline = db.pipeline().collection(collectionPath);

      // Apply filters
      if (filters.length === 1) {
        pipeline = pipeline.where(buildFilterExpression(P, filters[0]));
      } else if (filters.length > 1) {
        const [first, second, ...rest] = filters.map((f) => buildFilterExpression(P, f));
        pipeline = pipeline.where(P.and(first, second, ...rest));
      }

      // Apply sort
      if (options?.orderBy) {
        const f = P.field(options.orderBy.field);
        const ordering = options.orderBy.direction === 'desc' ? f.descending() : f.ascending();
        pipeline = pipeline.sort(ordering);
      }

      // Apply limit
      if (options?.limit !== undefined) {
        pipeline = pipeline.limit(options.limit);
      }

      const snap = await pipeline.execute();
      return snap.results.map((r) => r.data() as StoredGraphRecord);
    },
  };
}
