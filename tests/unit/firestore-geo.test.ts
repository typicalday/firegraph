/**
 * Unit tests for `src/internal/firestore-geo.ts` — the shared Pipelines
 * geospatial-distance translation used by Firestore Enterprise under
 * capability `search.geo`.
 *
 * Standard never declares the cap (geo is an Enterprise-only product
 * feature), so this helper has exactly one in-tree backend wrapper. The
 * tests below lock the validation surface (radius, limit, lat/lng range)
 * and the Pipelines composition (`search({ query: geoDistance(field,
 * point).lessThanOrEqual(radius), sort: geoDistance(...).ascending() })`)
 * without touching a real Enterprise project.
 */

import { describe, expect, it, vi } from 'vitest';

import { normalizeGeoFieldPath, runFirestoreGeoSearch } from '../../src/internal/firestore-geo.js';
import type { GeoSearchParams } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock @google-cloud/firestore. Stub `Pipelines` (geoDistance / equal /
// and) plus a minimal `GeoPoint` constructor — the helper instantiates
// `new GeoPoint(lat, lng)` before threading it into the pipeline expr.
// ---------------------------------------------------------------------------

interface TaggedExpr {
  __kind: string;
  args: unknown[];
}

vi.mock('@google-cloud/firestore', () => {
  class GeoPoint {
    constructor(
      public readonly latitude: number,
      public readonly longitude: number,
    ) {}
  }
  const Pipelines = {
    geoDistance: (field: string, point: GeoPoint) => ({
      __kind: 'geoDistance',
      args: [field, point],
      lessThanOrEqual(radius: number) {
        return {
          __kind: 'geoDistance.lessThanOrEqual',
          args: [field, point, radius],
        } as TaggedExpr;
      },
      ascending() {
        return { __kind: 'geoDistance.ascending', args: [field, point] } as TaggedExpr;
      },
    }),
    equal: (field: string, value: unknown) =>
      ({ __kind: 'equal', args: [field, value] }) as TaggedExpr,
    and: (...exprs: TaggedExpr[]) => ({ __kind: 'and', args: exprs }) as TaggedExpr,
  };
  return { Pipelines, GeoPoint };
});

// ---------------------------------------------------------------------------
// Mock pipeline builder chain.
// ---------------------------------------------------------------------------

interface StageCall {
  stage: string;
  args: unknown[];
}

function makeFakeDb(rows: Array<{ data: () => Record<string, unknown> }>): {
  db: unknown;
  calls: StageCall[];
} {
  const calls: StageCall[] = [];
  const pipeline: Record<string, unknown> = {};
  pipeline.collection = (path: string) => {
    calls.push({ stage: 'collection', args: [path] });
    return pipeline;
  };
  pipeline.search = (opts: unknown) => {
    calls.push({ stage: 'search', args: [opts] });
    return pipeline;
  };
  pipeline.where = (expr: unknown) => {
    calls.push({ stage: 'where', args: [expr] });
    return pipeline;
  };
  pipeline.limit = (n: number) => {
    calls.push({ stage: 'limit', args: [n] });
    return pipeline;
  };
  pipeline.execute = async () => {
    calls.push({ stage: 'execute', args: [] });
    return { results: rows };
  };
  const db: Record<string, unknown> = {
    pipeline: () => pipeline,
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// normalizeGeoFieldPath
// ---------------------------------------------------------------------------

describe('normalizeGeoFieldPath', () => {
  it('rewrites bare names to data.<name>', () => {
    expect(normalizeGeoFieldPath('location')).toBe('data.location');
  });

  it('passes through dotted data paths verbatim', () => {
    expect(normalizeGeoFieldPath('data.location')).toBe('data.location');
    expect(normalizeGeoFieldPath('data.address.geo')).toBe('data.address.geo');
  });

  it('passes through bare "data" (the entire data envelope)', () => {
    expect(normalizeGeoFieldPath('data')).toBe('data');
  });

  it('rejects every built-in envelope field with INVALID_QUERY', () => {
    for (const field of [
      'aType',
      'aUid',
      'axbType',
      'bType',
      'bUid',
      'createdAt',
      'updatedAt',
      'v',
    ]) {
      expect(() => normalizeGeoFieldPath(field)).toThrow(/built-in envelope field/);
    }
  });
});

// ---------------------------------------------------------------------------
// runFirestoreGeoSearch — validation surface
// ---------------------------------------------------------------------------

describe('runFirestoreGeoSearch — input validation', () => {
  function baseParams(overrides: Partial<GeoSearchParams> = {}): GeoSearchParams {
    return {
      geoField: 'location',
      point: { lat: 37.7749, lng: -122.4194 },
      radiusMeters: 1000,
      limit: 10,
      ...overrides,
    };
  }

  it('rejects a non-positive or non-finite radiusMeters', async () => {
    const { db } = makeFakeDb([]);
    for (const bad of [0, -1, NaN, Infinity]) {
      await expect(
        runFirestoreGeoSearch(db as never, 'graph', baseParams({ radiusMeters: bad })),
      ).rejects.toMatchObject({
        code: 'INVALID_QUERY',
        message: /radiusMeters must be a positive finite number/,
      });
    }
  });

  it('rejects a non-integer or non-positive limit', async () => {
    const { db } = makeFakeDb([]);
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(
        runFirestoreGeoSearch(db as never, 'graph', baseParams({ limit: bad })),
      ).rejects.toMatchObject({
        code: 'INVALID_QUERY',
        message: /limit must be a positive integer/,
      });
    }
  });

  it('rejects out-of-range latitude', async () => {
    const { db } = makeFakeDb([]);
    for (const bad of [-90.1, 90.1, NaN]) {
      await expect(
        runFirestoreGeoSearch(db as never, 'graph', baseParams({ point: { lat: bad, lng: 0 } })),
      ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /point\.lat must be in/ });
    }
  });

  it('rejects out-of-range longitude', async () => {
    const { db } = makeFakeDb([]);
    for (const bad of [-180.1, 180.1, NaN]) {
      await expect(
        runFirestoreGeoSearch(db as never, 'graph', baseParams({ point: { lat: 0, lng: bad } })),
      ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /point\.lng must be in/ });
    }
  });

  it('rejects an envelope-field geoField', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestoreGeoSearch(db as never, 'graph', baseParams({ geoField: 'aType' })),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /built-in envelope field/ });
  });
});

// ---------------------------------------------------------------------------
// runFirestoreGeoSearch — pipeline composition
// ---------------------------------------------------------------------------

describe('runFirestoreGeoSearch — pipeline composition', () => {
  function baseParams(overrides: Partial<GeoSearchParams> = {}): GeoSearchParams {
    return {
      geoField: 'location',
      point: { lat: 37.7749, lng: -122.4194 },
      radiusMeters: 1000,
      limit: 10,
      ...overrides,
    };
  }

  it('builds collection → search → limit when no identifying filters', async () => {
    const { db, calls } = makeFakeDb([
      {
        data: () => ({
          aType: 'place',
          aUid: 'u1',
          axbType: 'is',
          bType: 'place',
          bUid: 'u1',
          data: { location: { latitude: 37.7749, longitude: -122.4194 } },
        }),
      },
    ]);
    const out = await runFirestoreGeoSearch(db as never, 'graph', baseParams());
    expect(calls.map((c) => c.stage)).toEqual(['collection', 'search', 'limit', 'execute']);
    expect(calls[0].args[0]).toBe('graph');
    expect(calls[2].args[0]).toBe(10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
  });

  it('emits geoDistance(...).lessThanOrEqual(radius) inside search.query', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreGeoSearch(db as never, 'graph', baseParams({ radiusMeters: 2500 }));
    const searchOpts = calls.find((c) => c.stage === 'search')?.args[0] as {
      query: TaggedExpr;
      sort?: TaggedExpr;
    };
    expect(searchOpts.query).toMatchObject({
      __kind: 'geoDistance.lessThanOrEqual',
      args: ['data.location', expect.any(Object), 2500],
    });
  });

  it('emits geoDistance(...).ascending() inside search.sort by default (orderByDistance)', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreGeoSearch(db as never, 'graph', baseParams());
    const searchOpts = calls.find((c) => c.stage === 'search')?.args[0] as {
      query: TaggedExpr;
      sort?: TaggedExpr;
    };
    expect(searchOpts.sort).toMatchObject({
      __kind: 'geoDistance.ascending',
      args: ['data.location', expect.any(Object)],
    });
  });

  it('omits search.sort when orderByDistance is false', async () => {
    // Callers that already plan their own sort (or want raw insertion order)
    // should be able to opt out of the ascending-distance ordering. The
    // contract on `GeoSearchParams.orderByDistance` documents that exactly.
    const { db, calls } = makeFakeDb([]);
    await runFirestoreGeoSearch(db as never, 'graph', baseParams({ orderByDistance: false }));
    const searchOpts = calls.find((c) => c.stage === 'search')?.args[0] as {
      query: TaggedExpr;
      sort?: TaggedExpr;
    };
    expect(searchOpts.sort).toBeUndefined();
  });

  it('places a single identifying filter into a follow-up where(equal(...))', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreGeoSearch(db as never, 'graph', baseParams({ aType: 'place' }));
    expect(calls.map((c) => c.stage)).toEqual([
      'collection',
      'search',
      'where',
      'limit',
      'execute',
    ]);
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr).toMatchObject({ __kind: 'equal', args: ['aType', 'place'] });
  });

  it('combines multiple identifying filters with and(...)', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreGeoSearch(
      db as never,
      'graph',
      baseParams({ aType: 'place', axbType: 'near', bType: 'place' }),
    );
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr.__kind).toBe('and');
    expect((whereExpr.args as TaggedExpr[]).map((e) => e.args[0])).toEqual([
      'aType',
      'axbType',
      'bType',
    ]);
  });

  it('decodes the snapshot results into StoredGraphRecord[]', async () => {
    const { db } = makeFakeDb([
      {
        data: () => ({
          aType: 'place',
          aUid: 'u1',
          axbType: 'is',
          bType: 'place',
          bUid: 'u1',
          data: { name: 'Ferry Building' },
        }),
      },
      {
        data: () => ({
          aType: 'place',
          aUid: 'u2',
          axbType: 'is',
          bType: 'place',
          bUid: 'u2',
          data: { name: 'Coit Tower' },
        }),
      },
    ]);
    const out = await runFirestoreGeoSearch(db as never, 'graph', baseParams());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
    expect(out[1]).toMatchObject({ aUid: 'u2' });
  });
});
