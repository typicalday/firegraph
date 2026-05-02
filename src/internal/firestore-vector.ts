/**
 * Shared classic-API vector / nearest-neighbour translation for both
 * Firestore editions.
 *
 * Translates a `findNearest({ ... })` call into a `Query.findNearest(opts)`
 * VectorQuery and decodes the snapshot. Standard and Enterprise both
 * delegate here so the field-path normalisation, identifying-filter
 * application, validation surface, and result shape are guaranteed
 * identical across editions.
 *
 * Why the classic API on both editions: the Enterprise pipeline
 * `findNearest` stage is a future optimisation. Vector search's
 * deliverable is "top-K by similarity," and the classic
 * `Query.findNearest(...)` API already produces that on both editions
 * with identical index requirements. When pipeline `findNearest` becomes
 * preferable for some other reason (composing with other pipeline
 * stages), the wiring is additive — swap the implementation behind this
 * helper, callers don't change.
 *
 * Migrations are not applied to the result. The contract on
 * `StorageBackend.findNearest` documents the rationale: the vector
 * index walked the raw stored shape, and rehydrating through the
 * migration pipeline would change the candidate set the index already
 * chose.
 */

import type { FieldPath } from '@google-cloud/firestore';
import { type Query, type VectorValue } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { FindNearestParams, QueryFilter, StoredGraphRecord } from '../types.js';
import { applyFiltersToQuery } from './firestore-aggregate.js';

/**
 * Built-in envelope fields that must NOT be passed as `vectorField` or
 * `distanceResultField`. Vectors live inside `data`; the envelope is
 * reserved for firegraph metadata. Mirrors the projection /
 * filter-field contract.
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
 * Normalise a caller-supplied vector / distance-result field path. Bare
 * names rewrite to `data.<name>`; `'data'` and `'data.*'` pass through;
 * envelope fields are rejected (they aren't vector-indexable, and the
 * SDK reserves them as `distanceResultField` targets).
 */
export function normalizeVectorFieldPath(label: string, field: string): string {
  if (ENVELOPE_FIELDS.has(field)) {
    throw new FiregraphError(
      `findNearest(): ${label} '${field}' is a built-in envelope field — ` +
        `vectors must live under \`data.*\`. Use a path like 'data.${field}' ` +
        `if you really meant a nested data field.`,
      'INVALID_QUERY',
    );
  }
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Translate firegraph's identifying-filter shape (`aType`, `axbType`,
 * `bType`) plus the optional `where` array into a flat `QueryFilter[]`
 * that `applyFiltersToQuery` can consume. The client wrapper does
 * scan-protection on this same list before dispatching, so the order
 * (identifiers first, then user-supplied where) is the same one the
 * safety check saw.
 */
export function buildVectorFilters(params: FindNearestParams): QueryFilter[] {
  const filters: QueryFilter[] = [];
  if (params.aType) filters.push({ field: 'aType', op: '==', value: params.aType });
  if (params.axbType) filters.push({ field: 'axbType', op: '==', value: params.axbType });
  if (params.bType) filters.push({ field: 'bType', op: '==', value: params.bType });
  if (params.where) filters.push(...params.where);
  return filters;
}

/** Resolve a `queryVector` argument to a plain `number[]`. */
function toNumberArray(qv: number[] | { toArray(): number[] }): number[] {
  if (Array.isArray(qv)) return qv;
  if (typeof (qv as { toArray?: unknown }).toArray === 'function') {
    return (qv as VectorValue).toArray();
  }
  throw new FiregraphError(
    'findNearest(): queryVector must be a number[] or a Firestore VectorValue.',
    'INVALID_QUERY',
  );
}

/**
 * Run a vector query against a base Firestore `Query`. Returns the
 * matching records as `StoredGraphRecord[]`, ordered by similarity (the
 * SDK's natural order — nearest-first for EUCLIDEAN/COSINE,
 * highest-first for DOT_PRODUCT).
 *
 * Validation surface (matches the `VectorExtension` JSDoc):
 *
 *   - `vectorField` and `distanceResultField` (if set) must not be
 *     envelope fields.
 *   - `queryVector` must be a non-empty `number[]` / `VectorValue`.
 *   - `limit` must be a positive integer ≤ 1000 (the SDK enforces 1000
 *     on the wire; we mirror it client-side for a clearer error).
 */
export async function runFirestoreFindNearest(
  base: Query,
  params: FindNearestParams,
): Promise<StoredGraphRecord[]> {
  const vec = toNumberArray(params.queryVector);
  if (vec.length === 0) {
    throw new FiregraphError(
      'findNearest(): queryVector is empty — at least one dimension is required.',
      'INVALID_QUERY',
    );
  }
  if (!Number.isInteger(params.limit) || params.limit <= 0 || params.limit > 1000) {
    throw new FiregraphError(
      `findNearest(): limit must be a positive integer ≤ 1000 (got ${params.limit}).`,
      'INVALID_QUERY',
    );
  }

  const vectorField = normalizeVectorFieldPath('vectorField', params.vectorField);
  const distanceResultField =
    params.distanceResultField !== undefined
      ? normalizeVectorFieldPath('distanceResultField', params.distanceResultField)
      : undefined;

  const filtered = applyFiltersToQuery(base, buildVectorFilters(params));

  // Firestore's `findNearest({ vectorField, ... })` accepts a `string` or
  // `FieldPath` for both `vectorField` and `distanceResultField`. We pass
  // the dotted path verbatim — Firestore itself interprets `.` as the
  // field-path separator, matching the convention used everywhere else
  // in firegraph.
  const opts: {
    vectorField: string | FieldPath;
    queryVector: number[];
    limit: number;
    distanceMeasure: 'EUCLIDEAN' | 'COSINE' | 'DOT_PRODUCT';
    distanceThreshold?: number;
    distanceResultField?: string | FieldPath;
  } = {
    vectorField,
    queryVector: vec,
    limit: params.limit,
    distanceMeasure: params.distanceMeasure,
  };
  if (params.distanceThreshold !== undefined) opts.distanceThreshold = params.distanceThreshold;
  if (distanceResultField !== undefined) opts.distanceResultField = distanceResultField;

  // The classic `findNearest` returns a `VectorQuery` with its own `.get()`
  // that resolves to a `VectorQuerySnapshot`. The doc shape is identical
  // to a normal QueryDocumentSnapshot, so we can decode straight into
  // `StoredGraphRecord` like the regular `query()` adapter does.
  const snap = await filtered.findNearest(opts).get();
  return snap.docs.map((doc) => doc.data() as StoredGraphRecord);
}
