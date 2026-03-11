import { NODE_RELATION, DEFAULT_QUERY_LIMIT, BUILTIN_FIELDS } from './internal/constants.js';
import { computeEdgeDocId } from './docid.js';
import { InvalidQueryError } from './errors.js';
import type { FindEdgesParams, FindNodesParams, QueryPlan, QueryFilter } from './types.js';

export function buildEdgeQueryPlan(params: FindEdgesParams): QueryPlan {
  const { aType, aUid, axbType, bType, bUid, limit, orderBy } = params;

  if (aUid && axbType && bUid && !params.where?.length) {
    return { strategy: 'get', docId: computeEdgeDocId(aUid, axbType, bUid) };
  }

  const filters: QueryFilter[] = [];

  if (aType) filters.push({ field: 'aType', op: '==', value: aType });
  if (aUid) filters.push({ field: 'aUid', op: '==', value: aUid });
  if (axbType) filters.push({ field: 'axbType', op: '==', value: axbType });
  if (bType) filters.push({ field: 'bType', op: '==', value: bType });
  if (bUid) filters.push({ field: 'bUid', op: '==', value: bUid });

  if (params.where) {
    for (const clause of params.where) {
      const field = BUILTIN_FIELDS.has(clause.field) ? clause.field
        : clause.field.startsWith('data.') ? clause.field : `data.${clause.field}`;
      filters.push({ field, op: clause.op, value: clause.value });
    }
  }

  if (filters.length === 0) {
    throw new InvalidQueryError('findEdges requires at least one filter parameter');
  }

  // limit: undefined → apply DEFAULT_QUERY_LIMIT
  // limit: 0         → no limit (unlimited, used by internal bulk operations)
  // limit: N         → use N
  const effectiveLimit = limit === undefined ? DEFAULT_QUERY_LIMIT : (limit || undefined);
  return { strategy: 'query', filters, options: { limit: effectiveLimit, orderBy } };
}

export function buildNodeQueryPlan(params: FindNodesParams): QueryPlan {
  const { aType, limit, orderBy } = params;

  const filters: QueryFilter[] = [
    { field: 'aType', op: '==', value: aType },
    { field: 'axbType', op: '==', value: NODE_RELATION },
  ];

  if (params.where) {
    for (const clause of params.where) {
      const field = BUILTIN_FIELDS.has(clause.field) ? clause.field
        : clause.field.startsWith('data.') ? clause.field : `data.${clause.field}`;
      filters.push({ field, op: clause.op, value: clause.value });
    }
  }

  const effectiveLimit = limit === undefined ? DEFAULT_QUERY_LIMIT : (limit || undefined);
  return { strategy: 'query', filters, options: { limit: effectiveLimit, orderBy } };
}
