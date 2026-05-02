/**
 * Unit tests for `GraphClientImpl.findNearest()` — the public client surface
 * that fronts every backend's `findNearest(...)` implementation (Phase 8,
 * capability `search.vector`).
 *
 * The Firestore-side translation (vectorField path normalisation,
 * VectorQueryOptions assembly, distance metric / threshold passthrough) is
 * exercised by `tests/unit/firestore-vector.test.ts` against the shared
 * `runFirestoreFindNearest` helper. This file pins the *client-side* contract:
 *
 *   - throws `UNSUPPORTED_OPERATION` when the backend lacks `findNearest`
 *     (callers of a SQLite/DO-backed client get a clean, branded error rather
 *     than `Cannot read property 'findNearest' of undefined`).
 *   - filter assembly identical to the shared helper's `buildVectorFilters`
 *     ordering: identifying filters first (`aType`/`axbType`/`bType`), then
 *     user-supplied `where`. Pinning the order makes the safety-check input
 *     auditable.
 *   - scan-protection enforcement (`allowCollectionScan: false` is rejected
 *     for an unfiltered query, just like `findEdges`).
 *   - params pass-through: `vectorField`, `queryVector`, `limit`,
 *     `distanceMeasure`, and the optional `distanceThreshold` /
 *     `distanceResultField` thread to the backend verbatim — the helper does
 *     the SDK-shape work, the client never inspects the payload.
 *   - migration bypass: the vector index walks the raw stored shape;
 *     rehydrating each row through the migration pipeline would change the
 *     candidate set the index already chose. We pin that even when a
 *     matching registry entry is present on the client.
 */

import { describe, expect, it, vi } from 'vitest';

import { GraphClientImpl } from '../../src/client.js';
import type { BackendCapabilities, StorageBackend } from '../../src/internal/backend.js';
import type { Capability, FindNearestParams, StoredGraphRecord } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake backend — minimum shape for `GraphClientImpl`. Records every
// `findNearest` call for assertion.
// ---------------------------------------------------------------------------

interface NearestCall {
  params: FindNearestParams;
}

interface FakeBackend extends StorageBackend {
  nearestCalls: NearestCall[];
  nearestResponse: StoredGraphRecord[];
}

function makeCapabilities(caps: ReadonlySet<Capability>): BackendCapabilities {
  return {
    has: (c: Capability) => caps.has(c),
    values: () => caps.values(),
  };
}

function makeBackend(opts: { withVector: boolean }): FakeBackend {
  const nearestCalls: NearestCall[] = [];
  const backend = {
    capabilities: makeCapabilities(
      new Set<Capability>(
        opts.withVector
          ? ['core.read', 'core.write', 'search.vector']
          : ['core.read', 'core.write'],
      ),
    ),
    collectionPath: 'firegraph',
    scopePath: '',
    nearestCalls,
    nearestResponse: [] as StoredGraphRecord[],
    getDoc: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue([]),
    setDoc: vi.fn().mockResolvedValue(undefined),
    updateDoc: vi.fn().mockResolvedValue(undefined),
    deleteDoc: vi.fn().mockResolvedValue(undefined),
    runTransaction: vi.fn().mockResolvedValue(undefined),
    createBatch: vi.fn(),
    subgraph: vi.fn(),
    removeNodeCascade: vi.fn(),
    bulkRemoveEdges: vi.fn(),
  } as unknown as FakeBackend;

  if (opts.withVector) {
    backend.findNearest = (params: FindNearestParams) => {
      nearestCalls.push({ params });
      // Hand back a shallow clone so the caller can't mutate the canned
      // response and surprise the next assertion.
      return Promise.resolve(backend.nearestResponse.map((r) => ({ ...r })));
    };
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphClientImpl.findNearest — UNSUPPORTED_OPERATION when backend omits vector search', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.findNearest is missing', async () => {
    // Same contract shape as `findEdgesProjected` / `aggregate` / `bulkDelete`:
    // capability narrowing on the public client surface is type-level only;
    // the runtime guard inside `findNearest()` closes the gap so a
    // SQLite-/DO-backed caller hitting the wrong client gets a clean error
    // rather than a `Cannot read property 'findNearest' of undefined` crash.
    const backend = makeBackend({ withVector: false });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findNearest({
        aType: 'doc',
        vectorField: 'embedding',
        queryVector: [0.1, 0.2, 0.3],
        limit: 5,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('findNearest()'),
    });

    // Importantly: the runtime guard fires before any backend interaction.
    expect(backend.query).not.toHaveBeenCalled();
  });
});

describe('GraphClientImpl.findNearest — filter assembly + pass-through', () => {
  it('assembles identifying filters in helper order (aType, axbType, bType, then where)', async () => {
    // The shared `runFirestoreFindNearest` helper builds the same filter list
    // via `buildVectorFilters`. We mirror the order here so the
    // scan-protection check sees the same shape the backend will narrow on,
    // and so future helper changes don't silently diverge from the client.
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 10,
      distanceMeasure: 'COSINE',
      where: [{ field: 'data.published', op: '==', value: true }],
    });

    expect(backend.nearestCalls).toHaveLength(1);
    // Params thread through verbatim — the client never re-shapes them, the
    // helper does that work at the SDK boundary.
    expect(backend.nearestCalls[0]?.params).toMatchObject({
      aType: 'doc',
      axbType: 'is',
      bType: 'doc',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 10,
      distanceMeasure: 'COSINE',
      where: [{ field: 'data.published', op: '==', value: true }],
    });
  });

  it('forwards optional distanceThreshold and distanceResultField verbatim', async () => {
    // Optional-field pass-through: the client must not strip or normalise
    // these — the helper rewrites bare names like `'score'` → `'data.score'`
    // and handles the `DOT_PRODUCT` threshold-flip. Doing any of that work
    // here would either duplicate or fight the helper's contract.
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 5,
      distanceMeasure: 'DOT_PRODUCT',
      distanceThreshold: 0.85,
      distanceResultField: 'score',
    });

    expect(backend.nearestCalls).toHaveLength(1);
    expect(backend.nearestCalls[0]?.params).toMatchObject({
      distanceThreshold: 0.85,
      distanceResultField: 'score',
      distanceMeasure: 'DOT_PRODUCT',
    });
  });

  it('returns the backend rows unchanged', async () => {
    // The client is a pass-through for the result list — no migration, no
    // re-shaping. The pinned response shape lets us assert the helper's
    // sort order (Firestore's `findNearest` returns nearest-first for
    // EUCLIDEAN/COSINE) is preserved across the wrapper.
    const backend = makeBackend({ withVector: true });
    backend.nearestResponse = [
      {
        aType: 'doc',
        aUid: 'u1',
        axbType: 'is',
        bType: 'doc',
        bUid: 'u1',
        data: { embedding: [0.1, 0.2, 0.3], title: 'A' },
      } as unknown as StoredGraphRecord,
      {
        aType: 'doc',
        aUid: 'u2',
        axbType: 'is',
        bType: 'doc',
        bUid: 'u2',
        data: { embedding: [0.11, 0.21, 0.31], title: 'B' },
      } as unknown as StoredGraphRecord,
    ];
    const client = new GraphClientImpl(backend);

    const out = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 2,
      distanceMeasure: 'COSINE',
    });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
    expect(out[1]).toMatchObject({ aUid: 'u2' });
  });
});

describe('GraphClientImpl.findNearest — scan protection', () => {
  it('throws QUERY_SAFETY when no identifying filters / where are supplied', async () => {
    // An unfiltered vector search walks every row before the ANN narrowing
    // kicks in — exactly the same scan trap as an unfiltered `findEdges`.
    // The wrapper must enforce the same opt-in.
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findNearest({
        vectorField: 'embedding',
        queryVector: [0.1, 0.2, 0.3],
        limit: 5,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });

    // Safety check fires before backend dispatch.
    expect(backend.nearestCalls).toHaveLength(0);
  });

  it('honours allowCollectionScan: true as an explicit opt-in', async () => {
    // Same escape hatch as `findEdges` / `aggregate` / `findEdgesProjected`.
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await client.findNearest({
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 5,
      distanceMeasure: 'COSINE',
      allowCollectionScan: true,
    });

    expect(backend.nearestCalls).toHaveLength(1);
    expect(backend.nearestCalls[0]?.params.vectorField).toBe('embedding');
  });

  it('passes safety when identifying filters cover an indexed pattern (aType + axbType)', async () => {
    // Mirrors the `findEdges` safety analyser — the safe combos are
    // `(aUid + axbType)`, `(axbType + bUid)`, `(aType + axbType)`, and
    // `(axbType + bType)`. We pin `(aType + axbType)` here so the test
    // documents the exact narrowing the wrapper inherits from
    // `checkQuerySafety` (which is shared with every other find-* path).
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 5,
      distanceMeasure: 'COSINE',
      where: [{ field: 'data.published', op: '==', value: true }],
    });

    expect(backend.nearestCalls).toHaveLength(1);
  });

  it('rejects an unsafe filter set (aType alone) without allowCollectionScan', async () => {
    // `aType` by itself does not match any indexed pattern — the safety
    // analyser treats it as a partial filter that would still scan the
    // collection on Firestore Enterprise. Without `allowCollectionScan:
    // true` the wrapper must throw, identical to `findEdges`. Pinning
    // this rules out a regression where `findNearest` could quietly
    // accept under-narrowed filters.
    const backend = makeBackend({ withVector: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findNearest({
        aType: 'doc',
        vectorField: 'embedding',
        queryVector: [0.1, 0.2, 0.3],
        limit: 5,
        distanceMeasure: 'COSINE',
      }),
    ).rejects.toMatchObject({ code: 'QUERY_SAFETY' });
    expect(backend.nearestCalls).toHaveLength(0);
  });
});

describe('GraphClientImpl.findNearest — bypasses migration pipeline', () => {
  it('returns backend rows verbatim and never invokes any registry-bound migration', async () => {
    // A stored migration on `(doc, is, doc)` would, on a full-record read,
    // run during `applyMigrations` and rewrite the row. Vector search bypasses
    // that pipeline — see the JSDoc on `StorageBackend.findNearest` and
    // `VectorExtension`. The vector index walked the raw stored shape, and
    // re-running migrations could change the candidate set the index already
    // chose. We pin that behaviour even when a matching registry entry is
    // present on the client.
    const backend = makeBackend({ withVector: true });
    backend.nearestResponse = [
      {
        aType: 'doc',
        aUid: 'u1',
        axbType: 'is',
        bType: 'doc',
        bUid: 'u1',
        data: { embedding: [0.1, 0.2, 0.3], title: 'Original' },
      } as unknown as StoredGraphRecord,
    ];

    const migrationSpy = vi.fn((d: Record<string, unknown>) => ({ ...d, migrated: true }));
    const client = new GraphClientImpl(backend, {
      registry: {
        validate: () => undefined,
        lookup: () => ({
          aType: 'doc',
          axbType: 'is',
          bType: 'doc',
          schemaVersion: 1,
          migrations: [{ fromVersion: 0, toVersion: 1, up: migrationSpy }],
        }),
        lookupByAxbType: () => [],
        getSubgraphTopology: () => [],
        entries: () => [],
      },
    });

    const out = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 1,
      distanceMeasure: 'COSINE',
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
    // Migration must NOT have been invoked — the vector query selects rows
    // by similarity over the raw stored shape, not by query plan.
    expect(migrationSpy).not.toHaveBeenCalled();
  });
});
