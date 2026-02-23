import { NODE_RELATION } from './internal/constants.js';
import { computeEdgeDocId } from './docid.js';
import { InvalidQueryError } from './errors.js';
import type { FindEdgesParams, FindNodesParams, QueryPlan, QueryFilter } from './types.js';

export function buildEdgeQueryPlan(params: FindEdgesParams): QueryPlan {
  const { aType, aUid, axbType, bType, bUid, limit, orderBy } = params;

  if (aUid && axbType && bUid) {
    return { strategy: 'get', docId: computeEdgeDocId(aUid, axbType, bUid) };
  }

  const filters: QueryFilter[] = [];

  if (aType) filters.push({ field: 'aType', op: '==', value: aType });
  if (aUid) filters.push({ field: 'aUid', op: '==', value: aUid });
  if (axbType) filters.push({ field: 'axbType', op: '==', value: axbType });
  if (bType) filters.push({ field: 'bType', op: '==', value: bType });
  if (bUid) filters.push({ field: 'bUid', op: '==', value: bUid });

  if (filters.length === 0) {
    throw new InvalidQueryError('findEdges requires at least one filter parameter');
  }

  const options = (limit !== undefined || orderBy) ? { limit, orderBy } : undefined;
  return { strategy: 'query', filters, options };
}

export function buildNodeQueryPlan(params: FindNodesParams): QueryPlan {
  return {
    strategy: 'query',
    filters: [
      { field: 'aType', op: '==', value: params.aType },
      { field: 'axbType', op: '==', value: NODE_RELATION },
    ],
  };
}
