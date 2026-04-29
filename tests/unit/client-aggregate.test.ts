/**
 * Unit tests for `GraphClientImpl.aggregate()` — the public client surface
 * that fronts every backend's `aggregate(...)` implementation.
 *
 * The per-backend translation (Firestore classic API, SQLite SQL, DO RPC)
 * is covered by `firestore-aggregate.test.ts`, `sqlite-backend.test.ts`,
 * `cloudflare-sql.test.ts`, and `cloudflare-backend.test.ts`. This file
 * pins the *client-side* contract:
 *
 *   - throws UNSUPPORTED_OPERATION when the backend lacks `aggregate`
 *   - rejects a get-strategy spec (all three identifiers) with INVALID_QUERY
 *   - applies scan-protection like every other query path
 *   - accepts a zero-filter aggregate (e.g. count(*) over the table) when
 *     the caller opts in via `allowCollectionScan: true` — the audit
 *     finding I2 fix
 *   - threads the AggregateResult shape through unchanged
 */

import { describe, expect, it, vi } from 'vitest';

import { GraphClientImpl } from '../../src/client.js';
import type { BackendCapabilities, StorageBackend } from '../../src/internal/backend.js';
import type { AggregateSpec, Capability, QueryFilter } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake backend — implements just enough of `StorageBackend` to keep
// `GraphClientImpl` happy. The interesting behaviour is `aggregate()`.
// ---------------------------------------------------------------------------

interface FakeBackend extends StorageBackend {
  aggregateCalls: Array<{ spec: AggregateSpec; filters: QueryFilter[] }>;
  aggregateResponse: Record<string, number>;
}

function makeCapabilities(caps: ReadonlySet<Capability>): BackendCapabilities {
  return {
    has: (c: Capability) => caps.has(c),
    values: () => caps.values(),
  };
}

function makeBackend(opts: { withAggregate: boolean }): FakeBackend {
  const aggregateCalls: FakeBackend['aggregateCalls'] = [];
  const backend = {
    capabilities: makeCapabilities(
      new Set<Capability>(
        opts.withAggregate
          ? ['core.read', 'core.write', 'query.aggregate']
          : ['core.read', 'core.write'],
      ),
    ),
    collectionPath: 'firegraph',
    scopePath: '',
    aggregateCalls,
    aggregateResponse: { n: 0 },
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

  if (opts.withAggregate) {
    backend.aggregate = (spec, filters) => {
      aggregateCalls.push({ spec, filters });
      return Promise.resolve({ ...backend.aggregateResponse });
    };
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphClientImpl.aggregate — UNSUPPORTED_OPERATION when backend omits aggregate', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.aggregate is missing', async () => {
    // The capability gate is type-level on the public client. At runtime
    // the GraphClient.aggregate method is always present (the conditional
    // narrowing is purely TS), so we still need an explicit runtime guard.
    const backend = makeBackend({ withAggregate: false });
    const client = new GraphClientImpl(backend);

    await expect(
      client.aggregate({
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        aggregates: { n: { op: 'count' } },
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('aggregate()'),
    });
  });
});

describe('GraphClientImpl.aggregate — query strategy enforcement', () => {
  it('rejects a get-strategy spec (all three identifiers present) with INVALID_QUERY', async () => {
    // `findEdges` with all three identifiers (aUid, axbType, bUid) becomes
    // a single doc lookup. That makes no sense for an aggregate — there's
    // exactly one row at most. Reject so the caller fixes the spec.
    const backend = makeBackend({ withAggregate: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.aggregate({
        aUid: 'kX1nQ2mP9xR4wL1tY8s3a',
        axbType: 'hasDeparture',
        bUid: 'kX1nQ2mP9xR4wL1tY8s3b',
        aggregates: { n: { op: 'count' } },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('direct document lookup'),
    });
    expect(backend.aggregateCalls).toHaveLength(0);
  });

  it('forwards filtered specs to backend.aggregate with the planned filter list', async () => {
    const backend = makeBackend({ withAggregate: true });
    backend.aggregateResponse = { n: 4, total: 100, mean: 25 };
    const client = new GraphClientImpl(backend);

    const out = await client.aggregate({
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
      aggregates: {
        n: { op: 'count' },
        total: { op: 'sum', field: 'data.price' },
        mean: { op: 'avg', field: 'data.price' },
      },
    });

    expect(out).toEqual({ n: 4, total: 100, mean: 25 });
    expect(backend.aggregateCalls).toHaveLength(1);
    // The plan emits `aType`, `axbType`, `bType` filters in that order.
    expect(backend.aggregateCalls[0].filters).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'bType', op: '==', value: 'tour' },
    ]);
    // Spec passes through unchanged.
    expect(backend.aggregateCalls[0].spec).toEqual({
      n: { op: 'count' },
      total: { op: 'sum', field: 'data.price' },
      mean: { op: 'avg', field: 'data.price' },
    });
  });
});

describe('GraphClientImpl.aggregate — scan protection', () => {
  it('throws QuerySafetyError when the planned filters do not match a safe index pattern (default scanProtection: error)', async () => {
    // Default scanProtection is 'error'. A filter on `aType` alone doesn't
    // match any safe pattern (the analyzer expects at least an axbType
    // pairing). The aggregate path must run scan-safety checks just like
    // findEdges so a runaway COUNT(*) doesn't blow through Firestore reads.
    const backend = makeBackend({ withAggregate: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.aggregate({
        aType: 'tour',
        // No axbType / bUid → not a safe index pattern.
        aggregates: { n: { op: 'count' } },
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.aggregateCalls).toHaveLength(0);
  });

  it('honours allowCollectionScan: true to bypass scan protection', async () => {
    const backend = makeBackend({ withAggregate: true });
    backend.aggregateResponse = { n: 7 };
    const client = new GraphClientImpl(backend);

    const out = await client.aggregate({
      aType: 'tour',
      allowCollectionScan: true,
      aggregates: { n: { op: 'count' } },
    });

    expect(out).toEqual({ n: 7 });
    expect(backend.aggregateCalls).toHaveLength(1);
  });

  it('accepts an unfiltered aggregate (count(*) over the whole collection) with allowCollectionScan: true', async () => {
    // I2 fix: aggregate must allow zero-filter plans. Without the fix,
    // `buildEdgeQueryPlan` would throw because `findEdges` requires at
    // least one filter. count(*) over the whole table is the canonical
    // aggregate use case and should be reachable when the caller opts
    // in to a scan.
    const backend = makeBackend({ withAggregate: true });
    backend.aggregateResponse = { total: 42 };
    const client = new GraphClientImpl(backend);

    const out = await client.aggregate({
      allowCollectionScan: true,
      aggregates: { total: { op: 'count' } },
    });

    expect(out).toEqual({ total: 42 });
    expect(backend.aggregateCalls).toHaveLength(1);
    // Empty filter list flows straight through to the backend — the SQLite
    // and DO compilers handle the unfiltered case explicitly; the Firestore
    // helper applies an empty filter loop.
    expect(backend.aggregateCalls[0].filters).toEqual([]);
  });

  it('rejects unfiltered aggregate without allowCollectionScan when scanProtection is "error"', async () => {
    // Symmetry: opting out of the safety net is a deliberate caller choice.
    // An unfiltered count from a careless typo should still be caught.
    const backend = makeBackend({ withAggregate: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.aggregate({
        aggregates: { total: { op: 'count' } },
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.aggregateCalls).toHaveLength(0);
  });
});

describe('GraphClientImpl.aggregate — typed result threading', () => {
  it('returns the alias-keyed result shape unchanged from the backend', async () => {
    // The client is a thin pass-through for the aggregate result. Any
    // empty-set translation (null → 0/NaN) lives inside the backend
    // implementation; the client just types the return shape.
    const backend = makeBackend({ withAggregate: true });
    backend.aggregateResponse = { lo: 10, hi: 100, mean: Number.NaN };
    const client = new GraphClientImpl(backend);

    const out = await client.aggregate({
      aType: 'tour',
      axbType: 'is',
      aggregates: {
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
        mean: { op: 'avg', field: 'data.price' },
      },
    });

    expect(out.lo).toBe(10);
    expect(out.hi).toBe(100);
    expect(Number.isNaN(out.mean)).toBe(true);
  });
});
