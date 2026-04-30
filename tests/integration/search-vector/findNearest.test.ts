/**
 * Integration tests for `client.findNearest()` — Phase 8, capability
 * `search.vector`. Firestore-only (Standard + Enterprise both delegate to
 * the same shared `runFirestoreFindNearest` helper) — the SQLite-shaped
 * backends (shared SQLite, Cloudflare DO) do not declare `search.vector`
 * because they have no native ANN index and emulating it on top of
 * `json_extract` is a non-starter for any realistic dataset.
 *
 * ## Status: SKIPPED in the emulator suite — see the limitation note below
 *
 * The Firestore emulator's `findNearest` does NOT support nested-field
 * vector paths. Direct experimentation (firebase-tools 14.26 against the
 * emulator on port 8188) confirms:
 *
 *   - `vectorField: 'embedding'` (top-level)         → returns rows
 *   - `vectorField: 'data.embedding'`                → returns []
 *   - `vectorField: new FieldPath('data', 'embedding')` → returns []
 *
 * firegraph stores user data under the `data.*` envelope, so every vector
 * indexed by a real caller lives at a nested path. The unit suite
 * (`tests/unit/firestore-vector.test.ts`) mocks the Firestore SDK and
 * pins the exact `findNearest({ ... })` opts shape — including bare-name
 * normalisation, envelope rejection, queryVector coercion, limit bounds,
 * and threading of optional fields. That is the contract production
 * Firestore actually reads against.
 *
 * Production validation (real Standard / Enterprise project) needs:
 *
 *   - a single-field vector index on `data.<field>`, plus
 *   - a composite index when the query composes with `where` filters.
 *
 * `firegraph` does not auto-provision either; consumers configure them
 * once per project in the Firestore console.
 *
 * The suite below stays in the tree as `describe.skip(...)` so:
 *
 *   1. The shape of the contract test is recorded — when the emulator
 *      grows nested-vector support, flip the `.skip` to `.only` (or
 *      remove it) and the file just runs.
 *   2. CI doesn't fail on a known-unimplementable path while we still
 *      run the unit + capability tests on every push.
 *
 * What this file would pin once the emulator catches up:
 *
 *   - bare-name normalisation: `vectorField: 'embedding'` → `data.embedding`.
 *   - distance-measure semantics for EUCLIDEAN, COSINE, and DOT_PRODUCT:
 *     EUCLIDEAN/COSINE return nearest-first by distance; DOT_PRODUCT is
 *     "higher = more similar", so the `distanceThreshold` filter flips.
 *   - `distanceResultField` populates the per-row distance at the
 *     supplied dotted path (with bare-name → `data.*` rewrite).
 *   - identifying filters (`aType`, `axbType`, `bType`) narrow the
 *     candidate set before the ANN walk.
 *   - scan-protection rejects unfiltered vector queries with QUERY_SAFETY
 *     unless `allowCollectionScan: true` is explicitly set.
 *   - INVALID_QUERY at the validation surface for empty `queryVector`,
 *     out-of-range `limit`, and envelope-field `vectorField`.
 *
 * What this file deliberately does NOT pin (covered elsewhere):
 *
 *   - migration bypass on the read path — `tests/unit/client-find-nearest.test.ts`.
 *   - byte-level shape of the emitted Firestore RPC —
 *     `tests/unit/firestore-vector.test.ts` (mocked SDK).
 *   - capability declarations and routing pass-through —
 *     `tests/unit/capabilities.test.ts`, `tests/unit/routing-backend.test.ts`.
 */

import { FieldValue } from '@google-cloud/firestore';
import { beforeAll, describe, expect, it } from 'vitest';

import type { GraphClient } from '../../../src/types.js';
import { createTestGraphClient, skipIfSqlite, uniqueCollectionPath } from '../setup.js';

// Three 3-D embeddings positioned to make the nearest-neighbour ranking
// obvious without depending on floating-point ties:
//
//   - `near`  = [1, 0, 0]   — the query vector itself
//   - `mid`   = [0.6, 0.8, 0]
//   - `far`   = [0, 0, 1]   — orthogonal to the query
//
// Under EUCLIDEAN/COSINE: near < mid < far. Under DOT_PRODUCT (higher =
// more similar) the order is the same here because all vectors are unit
// length, but the threshold-filter direction flips.
const QUERY_VECTOR = [1, 0, 0];
const NODES = [
  { uid: 'near', name: 'near', embedding: [1, 0, 0] },
  { uid: 'mid', name: 'mid', embedding: [0.6, 0.8, 0] },
  { uid: 'far', name: 'far', embedding: [0, 0, 1] },
] as const;

describe.skip('findNearest — vector search contract (emulator skip — see file header)', () => {
  let g: GraphClient;

  beforeAll(async () => {
    // SQLite/DO don't declare `search.vector` — there is no native ANN
    // index and emulating one is intentionally out of scope.
    if (skipIfSqlite({ skip: () => {} })) return;

    g = createTestGraphClient(uniqueCollectionPath());

    // Seed the three test nodes with `embedding` stored as a proper
    // VectorValue (`FieldValue.vector(...)`). Firestore stores plain
    // `number[]` as an Array, which is NOT vector-indexable; the SDK only
    // surfaces it for `findNearest` when it's a VectorValue.
    for (const n of NODES) {
      await g.putNode('doc', n.uid, {
        name: n.name,
        embedding: FieldValue.vector(n.embedding as unknown as number[]),
      });
    }
  });

  it('rewrites bare-name vectorField as data.<name> and ranks nearest-first under COSINE', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // The most common shape: `vectorField: 'embedding'` resolves to
    // `data.embedding`. COSINE returns nearest-first by angle; with our
    // unit-length vectors the order is `near → mid → far`.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'COSINE',
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid', 'far']);
  });

  it('accepts an explicit dotted path verbatim (data.embedding)', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Same query as above but with the explicit `data.embedding` path —
    // the helper must not double-prefix or re-segment.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'data.embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'COSINE',
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid', 'far']);
  });

  it('ranks under EUCLIDEAN by straight-line distance (lower = nearer)', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // EUCLIDEAN(`near`, q) = 0; (`mid`, q) ≈ 0.83; (`far`, q) ≈ 1.41.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'EUCLIDEAN',
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid', 'far']);
  });

  it('ranks under DOT_PRODUCT with higher inner product as more similar', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // DOT_PRODUCT(`near`, q) = 1; (`mid`, q) = 0.6; (`far`, q) = 0.
    // Firestore returns highest-first under DOT_PRODUCT, so the ordering
    // matches the EUCLIDEAN/COSINE case here.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'DOT_PRODUCT',
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid', 'far']);
  });

  it('honours limit by truncating the result set', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // limit: 2 keeps only the two nearest under COSINE.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 2,
      distanceMeasure: 'COSINE',
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid']);
  });

  it('populates distanceResultField with the computed distance under bare-name normalisation', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Bare-name `'score'` resolves to `data.score`. Each returned row
    // should carry a numeric distance; under EUCLIDEAN, `near`'s
    // distance is 0 (the query vector itself).
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'EUCLIDEAN',
      distanceResultField: 'score',
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const data = row.data as Record<string, unknown>;
      expect(typeof data.score).toBe('number');
    }
    // The first row is `near`, identical to the query — distance is 0.
    const nearRow = rows.find((r) => r.aUid === 'near');
    expect(nearRow).toBeDefined();
    expect((nearRow!.data as Record<string, number>).score).toBeCloseTo(0, 5);
  });

  it('filters by distanceThreshold under EUCLIDEAN (rows with distance ≤ threshold)', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Threshold 0.9 keeps `near` (0) and `mid` (~0.83), drops `far`
    // (~1.41). Demonstrates the "lower = more similar" semantics.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 10,
      distanceMeasure: 'EUCLIDEAN',
      distanceThreshold: 0.9,
    });

    expect(rows.map((r) => r.aUid).sort()).toEqual(['mid', 'near']);
  });

  it('filters by distanceThreshold under DOT_PRODUCT (rows with distance ≥ threshold — flipped semantics)', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // DOT_PRODUCT flips: threshold 0.5 keeps `near` (1.0) and `mid`
    // (0.6), drops `far` (0.0). The semantics flip is the whole reason
    // FindNearestParams calls this out in its JSDoc.
    const rows = await g.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 10,
      distanceMeasure: 'DOT_PRODUCT',
      distanceThreshold: 0.5,
    });

    expect(rows.map((r) => r.aUid).sort()).toEqual(['mid', 'near']);
  });

  it('rejects an unfiltered query with QUERY_SAFETY (scan protection)', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // No identifying filters, no `where`, no `allowCollectionScan` →
    // scan-protection trips at the client surface before the RPC fires.
    await expect(
      g.findNearest({
        vectorField: 'embedding',
        queryVector: QUERY_VECTOR,
        limit: 3,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({ code: 'QUERY_SAFETY' });
  });

  it('allows an unfiltered query when allowCollectionScan is set', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Same shape as the previous test but with the opt-in flag — the
    // scan-protection check stands aside and the query reaches Firestore.
    const rows = await g.findNearest({
      vectorField: 'embedding',
      queryVector: QUERY_VECTOR,
      limit: 3,
      distanceMeasure: 'COSINE',
      allowCollectionScan: true,
    });

    expect(rows.map((r) => r.aUid)).toEqual(['near', 'mid', 'far']);
  });

  it('rejects an empty queryVector with INVALID_QUERY', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Validation surface — the helper fails fast before Firestore would
    // return an opaque "vector dimension mismatch".
    await expect(
      g.findNearest({
        aType: 'doc',
        axbType: 'is',
        bType: 'doc',
        vectorField: 'embedding',
        queryVector: [],
        limit: 3,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /queryVector is empty/,
    });
  });

  it('rejects out-of-range limit values with INVALID_QUERY', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Firestore caps `limit` at 1000 server-side; we mirror it client-side
    // for a clearer / branded error.
    await expect(
      g.findNearest({
        aType: 'doc',
        axbType: 'is',
        bType: 'doc',
        vectorField: 'embedding',
        queryVector: QUERY_VECTOR,
        limit: 0,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /limit must be/,
    });
    await expect(
      g.findNearest({
        aType: 'doc',
        axbType: 'is',
        bType: 'doc',
        vectorField: 'embedding',
        queryVector: QUERY_VECTOR,
        limit: 1001,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /limit must be/,
    });
  });

  it('rejects an envelope-field vectorField with INVALID_QUERY', async (ctx) => {
    if (skipIfSqlite(ctx)) return;
    // Envelope fields aren't vector-indexable — the helper rejects them
    // before the RPC fires so the user sees a branded error.
    await expect(
      g.findNearest({
        aType: 'doc',
        axbType: 'is',
        bType: 'doc',
        vectorField: 'aType',
        queryVector: QUERY_VECTOR,
        limit: 3,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /built-in envelope field/,
    });
  });
});
