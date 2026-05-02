/**
 * Shared Pipelines-API geospatial distance translation for Firestore Enterprise.
 *
 * Translates a `geoSearch({ ... })` call into a
 * `db.pipeline().collection(path).search({ query: geoDistance(field, point).lessThanOrEqual(radius), sort: geoDistance(...).ascending() }).where(...).limit(N).execute()`
 * pipeline and decodes the result. Only the Enterprise backend wires
 * this helper today — Firestore Standard does not support the
 * geospatial index (an Enterprise-only product feature), and the
 * SQLite-shaped backends have no native geo index.
 *
 * Why pipelines (not classic): Firestore's classic Query API has no
 * geospatial primitive. The 8.5.0 SDK exposes typed `geoDistance(...)`
 * inside the `Pipeline.search(...)` stage; we use it directly and
 * avoid the `rawStage(...)` escape hatch.
 *
 * The `search` stage **must be the first stage** of a pipeline. So
 * identifying filters (`aType` / `axbType` / `bType`) go into a
 * follow-up `where(...)` stage rather than `search.query`. The radius
 * cap stays inside `search.query` (where the geo index can apply it
 * efficiently); the same `geoDistance(...)` expression also feeds
 * `search.sort` for nearest-first ordering when `orderByDistance` is
 * true / unset.
 *
 * Migrations are not applied to the result — same rationale as
 * `findNearest` / `fullTextSearch`.
 */

import type { Firestore, Pipelines } from '@google-cloud/firestore';
import { GeoPoint } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { GeoSearchParams, StoredGraphRecord } from '../types.js';

/**
 * Built-in envelope fields that must NOT be passed as `geoField`. Geo
 * indexes live inside `data`; the envelope is reserved for firegraph
 * metadata. Mirrors the projection / vector / FTS rejection list.
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
 * Normalise a caller-supplied geo-field path. Bare names rewrite to
 * `data.<name>`; `'data'` and `'data.*'` pass through; envelope fields
 * are rejected.
 */
export function normalizeGeoFieldPath(field: string): string {
  if (ENVELOPE_FIELDS.has(field)) {
    throw new FiregraphError(
      `geoSearch(): geoField '${field}' is a built-in envelope field — ` +
        `geo-indexed fields must live under \`data.*\`. Use a path like ` +
        `'data.${field}' if you really meant a nested data field.`,
      'INVALID_QUERY',
    );
  }
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/** Lat/lng range check. Mirrors Firestore's GeoPoint constructor validation. */
function assertValidGeoPoint(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new FiregraphError(
      `geoSearch(): point.lat must be in [-90, 90] (got ${lat}).`,
      'INVALID_QUERY',
    );
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new FiregraphError(
      `geoSearch(): point.lng must be in [-180, 180] (got ${lng}).`,
      'INVALID_QUERY',
    );
  }
}

let _Pipelines: typeof Pipelines | null = null;

async function getPipelines(): Promise<typeof Pipelines> {
  if (!_Pipelines) {
    const mod = await import('@google-cloud/firestore');
    _Pipelines = mod.Pipelines;
  }
  return _Pipelines;
}

/**
 * Run a geospatial distance search against a collection path. Returns
 * rows whose `geoField` is within `radiusMeters` of `point`, ordered
 * nearest-first by default.
 *
 * Validation surface:
 *
 *   - `geoField` must not be an envelope field; bare names are rewritten
 *     to `data.<name>`.
 *   - `point.lat` must be in `[-90, 90]`, `point.lng` in `[-180, 180]`.
 *   - `radiusMeters` must be a positive finite number.
 *   - `limit` must be a positive integer.
 *
 * Scan-protection lives in the client wrapper (same as `findNearest`
 * and `fullTextSearch`).
 */
export async function runFirestoreGeoSearch(
  db: Firestore,
  collectionPath: string,
  params: GeoSearchParams,
): Promise<StoredGraphRecord[]> {
  if (!Number.isFinite(params.radiusMeters) || params.radiusMeters <= 0) {
    throw new FiregraphError(
      `geoSearch(): radiusMeters must be a positive finite number (got ${params.radiusMeters}).`,
      'INVALID_QUERY',
    );
  }
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new FiregraphError(
      `geoSearch(): limit must be a positive integer (got ${params.limit}).`,
      'INVALID_QUERY',
    );
  }
  assertValidGeoPoint(params.point.lat, params.point.lng);

  const geoFieldPath = normalizeGeoFieldPath(params.geoField);
  const center = new GeoPoint(params.point.lat, params.point.lng);

  const P = await getPipelines();

  // The geoDistance expression appears in two places: the search query
  // (as `<= radius`) and the search sort (as `.ascending()`). Build it
  // once and reuse — the SDK will treat the two calls as equivalent
  // server-side, but it's clearer to mirror the docstring shape.
  const distanceQuery = P.geoDistance(geoFieldPath, center).lessThanOrEqual(params.radiusMeters);

  // Build the search stage. `orderByDistance` defaults to true — that's
  // the contract on `GeoSearchParams`. The same `geoDistance(...)`
  // expression feeds the radius filter (`<= radius`) and the
  // ascending-distance sort.
  const orderByDistance = params.orderByDistance !== false;
  const opts: { query: Pipelines.BooleanExpression; sort?: Pipelines.Ordering } = {
    query: distanceQuery,
  };
  if (orderByDistance) {
    opts.sort = P.geoDistance(geoFieldPath, center).ascending();
  }

  let pipeline = db.pipeline().collection(collectionPath).search(opts);

  // Identifying filters land *after* `search()` (same constraint as FTS).
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

  const snap = await pipeline.execute();
  return snap.results.map((r) => r.data() as StoredGraphRecord);
}
