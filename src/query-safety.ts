import { BUILTIN_FIELDS } from './internal/constants.js';
import type { QueryFilter } from './types.js';

/**
 * Result of analyzing a query for collection scan risk.
 */
export interface QuerySafetyResult {
  /** Whether the query matches a known indexed pattern. */
  safe: boolean;
  /** Human-readable explanation when the query is unsafe. */
  reason?: string;
}

/**
 * Known composite index patterns that prevent full collection scans.
 * Each pattern is a set of field names that must ALL be present in the
 * query filters. Order within the set doesn't matter — what matters is
 * that the Firestore composite index covers the combination.
 *
 * These correspond to the indexes in firestore.indexes.json:
 *   (aUid, axbType)  — forward edge lookup
 *   (axbType, bUid)  — reverse edge lookup
 *   (aType, axbType)  — type-scoped queries + findNodes
 *   (axbType, bType)  — edge type + target type
 */
const SAFE_INDEX_PATTERNS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['aUid', 'axbType']),
  new Set(['axbType', 'bUid']),
  new Set(['aType', 'axbType']),
  new Set(['axbType', 'bType']),
];

/**
 * Analyzes a set of query filters to determine whether the query would
 * likely cause a full collection scan on Firestore Enterprise.
 *
 * A query is considered "safe" if the builtin fields present in the filters
 * match at least one known composite index pattern. Queries that only use
 * `data.*` fields without a safe base pattern are flagged as unsafe.
 */
export function analyzeQuerySafety(filters: QueryFilter[]): QuerySafetyResult {
  // Extract the set of builtin fields being filtered on (equality checks are
  // the primary index-usable operations, but we're generous here and count
  // any filter on a builtin field as potentially index-backed).
  const builtinFieldsPresent = new Set<string>();
  let hasDataFilters = false;

  for (const f of filters) {
    if (BUILTIN_FIELDS.has(f.field)) {
      builtinFieldsPresent.add(f.field);
    } else {
      // data.* or other non-builtin fields
      hasDataFilters = true;
    }
  }

  // Check if the builtin fields match any known safe index pattern.
  // A pattern is "matched" if all fields in the pattern are present in the query.
  for (const pattern of SAFE_INDEX_PATTERNS) {
    let matched = true;
    for (const field of pattern) {
      if (!builtinFieldsPresent.has(field)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // Even with data.* filters, the base index narrows the scan significantly.
      // The data.* filters are applied as post-filters on the index results.
      return { safe: true };
    }
  }

  // No safe pattern matched — build an explanation.
  const presentFields = [...builtinFieldsPresent];
  if (presentFields.length === 0 && hasDataFilters) {
    return {
      safe: false,
      reason:
        'Query filters only use data.* fields with no builtin field constraints. ' +
        'This requires a full collection scan. Add aType, aUid, axbType, bType, or bUid filters, ' +
        'or set allowCollectionScan: true.',
    };
  }

  if (hasDataFilters) {
    return {
      safe: false,
      reason:
        `Query filters on [${presentFields.join(', ')}] do not match any indexed pattern. ` +
        'data.* filters without an indexed base require a full collection scan. ' +
        `Safe patterns: (aUid + axbType), (axbType + bUid), (aType + axbType), (axbType + bType). ` +
        'Set allowCollectionScan: true to override.',
    };
  }

  return {
    safe: false,
    reason:
      `Query filters on [${presentFields.join(', ')}] do not match any indexed pattern. ` +
      'This may cause a full collection scan on Firestore Enterprise. ' +
      `Safe patterns: (aUid + axbType), (axbType + bUid), (aType + axbType), (axbType + bType). ` +
      'Set allowCollectionScan: true to override.',
  };
}
