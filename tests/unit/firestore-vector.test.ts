/**
 * Unit tests for `src/internal/firestore-vector.ts` — the shared classic-API
 * vector / nearest-neighbour translation used by both Firestore editions
 * (Standard and Enterprise) under capability `search.vector`.
 *
 * The two backend wrappers (`firestore-standard/backend.ts`,
 * `firestore-enterprise/backend.ts`) delegate to `runFirestoreFindNearest`
 * verbatim. By covering the helper here, we lock down the validation
 * surface — bare-name path normalisation, envelope-field rejection,
 * `queryVector` shape coercion, and the `limit` 1..1000 bounds — once,
 * regardless of which edition is plugged in.
 *
 * The actual Firestore SDK call (`Query.findNearest(opts).get()`) is mocked
 * out so these tests can run inside `pnpm test:unit` without an emulator.
 * The integration coverage at
 * `tests/integration/search-vector/findNearest.test.ts` exercises the
 * end-to-end Firestore wire path.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildVectorFilters,
  normalizeVectorFieldPath,
  runFirestoreFindNearest,
} from '../../src/internal/firestore-vector.js';
import type { FindNearestParams } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock Firestore Query — only the methods the helper actually calls.
// `findNearest(opts).get()` returns a fake `VectorQuerySnapshot` with the
// canned `docs` array; `where(...)` is a chainable no-op for filter-application
// since we assert against captured `findNearest` opts directly.
// ---------------------------------------------------------------------------

interface FakeDoc {
  data(): Record<string, unknown>;
}
interface CapturedNearestOpts {
  vectorField: unknown;
  queryVector: unknown;
  limit: number;
  distanceMeasure: string;
  distanceThreshold?: number;
  distanceResultField?: unknown;
}

function makeQuery(docs: FakeDoc[] = []): {
  q: unknown;
  capturedOpts: { value?: CapturedNearestOpts };
} {
  const captured: { value?: CapturedNearestOpts } = {};
  // Self-returning chain — `where()` returns the same fake so
  // `applyFiltersToQuery` can compose any number of filters before the
  // helper hits `.findNearest(...)`.
  const q: Record<string, unknown> = {};
  q.where = () => q;
  q.findNearest = (opts: CapturedNearestOpts) => {
    captured.value = opts;
    return {
      get: () => Promise.resolve({ docs }),
    };
  };
  return { q, capturedOpts: captured };
}

// ---------------------------------------------------------------------------
// normalizeVectorFieldPath
// ---------------------------------------------------------------------------

describe('normalizeVectorFieldPath', () => {
  it('rewrites bare names to data.<name>', () => {
    // Same convention as `select` / `where.field`: bare names live under
    // `data` because the envelope is reserved for firegraph metadata.
    expect(normalizeVectorFieldPath('vectorField', 'embedding')).toBe('data.embedding');
  });

  it('passes through dotted data paths verbatim', () => {
    // `data.x.y` → identity. The helper must not double-prefix or
    // re-segment — Firestore interprets `.` as the field separator.
    expect(normalizeVectorFieldPath('vectorField', 'data.embedding')).toBe('data.embedding');
    expect(normalizeVectorFieldPath('vectorField', 'data.nested.embed')).toBe('data.nested.embed');
  });

  it('passes through bare "data" (the entire data envelope)', () => {
    // Edge case — caller wrote literally `'data'` as the path. We trust it
    // even though it's an unlikely indexable shape; rejecting would be a
    // false positive against a valid (if exotic) Firestore index spec.
    expect(normalizeVectorFieldPath('vectorField', 'data')).toBe('data');
  });

  it('rejects every built-in envelope field with INVALID_QUERY', () => {
    // Mirrors the projection / where-clause field-rejection list. The
    // envelope is reserved for firegraph metadata and is not vector-indexable.
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
      expect(() => normalizeVectorFieldPath('vectorField', field)).toThrow(
        /built-in envelope field/,
      );
    }
  });

  it('uses the supplied label in the error so callers see vectorField vs distanceResultField', () => {
    // The two paths share the same validation but diverge in the error
    // message — pinning the label keeps the user-facing message accurate.
    expect(() => normalizeVectorFieldPath('distanceResultField', 'aUid')).toThrow(
      /distanceResultField 'aUid'/,
    );
  });
});

// ---------------------------------------------------------------------------
// buildVectorFilters
// ---------------------------------------------------------------------------

describe('buildVectorFilters', () => {
  it('produces identifying filters in (aType, axbType, bType) order, then where', () => {
    // The client-side scan-protection check inspects this same list, so the
    // order matters for diff-stability and for matching the order shown in
    // FindNearestParams docs.
    const params: FindNearestParams = {
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: [0.1],
      limit: 1,
      distanceMeasure: 'COSINE',
      where: [{ field: 'data.published', op: '==', value: true }],
    };
    expect(buildVectorFilters(params)).toEqual([
      { field: 'aType', op: '==', value: 'doc' },
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'bType', op: '==', value: 'doc' },
      { field: 'data.published', op: '==', value: true },
    ]);
  });

  it('omits identifying filters that are not set (no empty-string equality on absent fields)', () => {
    // Otherwise every unfiltered call would emit `aType == ''`, narrowing
    // to nothing instead of "no filter on aType".
    const params: FindNearestParams = {
      vectorField: 'embedding',
      queryVector: [0.1],
      limit: 1,
      distanceMeasure: 'COSINE',
    };
    expect(buildVectorFilters(params)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runFirestoreFindNearest — validation surface
// ---------------------------------------------------------------------------

describe('runFirestoreFindNearest — input validation', () => {
  it('rejects an empty queryVector', async () => {
    // A zero-length vector can't match anything; failing fast at the
    // boundary gives a branded error instead of an opaque
    // "INVALID_ARGUMENT: vector dimension mismatch" from Firestore.
    const { q } = makeQuery();
    await expect(
      runFirestoreFindNearest(q as never, {
        vectorField: 'embedding',
        queryVector: [],
        limit: 5,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /queryVector is empty/ });
  });

  it('coerces a VectorValue-shaped queryVector via .toArray()', async () => {
    // The `FindNearestParams.queryVector` type accepts `number[] |
    // { toArray(): number[] }`. The helper should call `.toArray()` once
    // and pass the resulting plain array to Firestore.
    const { q, capturedOpts } = makeQuery();
    const toArray = vi.fn(() => [0.1, 0.2, 0.3]);
    await runFirestoreFindNearest(q as never, {
      vectorField: 'embedding',
      queryVector: { toArray },
      limit: 5,
      distanceMeasure: 'COSINE',
    });
    expect(toArray).toHaveBeenCalledTimes(1);
    expect(capturedOpts.value?.queryVector).toEqual([0.1, 0.2, 0.3]);
  });

  it('rejects a non-integer or out-of-range limit', async () => {
    // Firestore caps `findNearest.limit` at 1000 server-side; we mirror it
    // client-side so the error is branded and consistent.
    const { q } = makeQuery();
    for (const bad of [0, -1, 1001, 1.5, NaN]) {
      await expect(
        runFirestoreFindNearest(q as never, {
          vectorField: 'embedding',
          queryVector: [0.1],
          limit: bad,
          distanceMeasure: 'COSINE',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /limit must be/ });
    }
  });

  it('threads optional distanceThreshold and distanceResultField into VectorQueryOptions', async () => {
    // The helper must pass these through verbatim (with the
    // distanceResultField bare-name → data.* rewrite) so callers can
    // recover the per-row distance for ranking / thresholding.
    const { q, capturedOpts } = makeQuery();
    await runFirestoreFindNearest(q as never, {
      vectorField: 'embedding',
      queryVector: [0.1],
      limit: 5,
      distanceMeasure: 'DOT_PRODUCT',
      distanceThreshold: 0.85,
      distanceResultField: 'score',
    });
    expect(capturedOpts.value).toMatchObject({
      vectorField: 'data.embedding',
      queryVector: [0.1],
      limit: 5,
      distanceMeasure: 'DOT_PRODUCT',
      distanceThreshold: 0.85,
      distanceResultField: 'data.score',
    });
  });

  it('omits distanceThreshold and distanceResultField when not set', async () => {
    // Firestore distinguishes "absent" from "undefined" in
    // VectorQueryOptions — passing `undefined` for `distanceThreshold`
    // would bind the option to its sentinel rather than leaving it
    // unconstrained. The helper must omit the keys entirely.
    const { q, capturedOpts } = makeQuery();
    await runFirestoreFindNearest(q as never, {
      vectorField: 'embedding',
      queryVector: [0.1],
      limit: 5,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(capturedOpts.value).toBeDefined();
    expect('distanceThreshold' in capturedOpts.value!).toBe(false);
    expect('distanceResultField' in capturedOpts.value!).toBe(false);
  });

  it('decodes the snapshot docs into StoredGraphRecord[]', async () => {
    // The fake snapshot returns `docs.map(doc => doc.data())` — same
    // shape the regular `query()` adapter uses. Pinning that the helper
    // doesn't strip or re-shape envelope fields.
    const { q } = makeQuery([
      {
        data: () => ({
          aType: 'doc',
          aUid: 'u1',
          axbType: 'is',
          bType: 'doc',
          bUid: 'u1',
          data: { embedding: [0.1, 0.2, 0.3] },
        }),
      },
    ]);
    const out = await runFirestoreFindNearest(q as never, {
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 1,
      distanceMeasure: 'COSINE',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
  });
});
