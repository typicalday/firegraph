/**
 * Unit tests for `GraphClientImpl.findEdgesProjected()` — the public client
 * surface that fronts every backend's `findEdgesProjected(...)` implementation
 * (Phase 7, capability `query.select`).
 *
 * The per-backend translation (SQLite `SELECT json_extract(...)`, DO RPC,
 * Firestore `Query.select(...)`) is covered by `sqlite-backend.test.ts`,
 * `cloudflare-sql.test.ts`, and the Firestore aggregate/projection helper
 * tests. This file pins the *client-side* contract:
 *
 *   - throws UNSUPPORTED_OPERATION when the backend lacks `findEdgesProjected`
 *     (Firestore-without-the-cap caller hitting the wrong client gets a clean
 *     error rather than `Cannot read property 'findEdgesProjected' of undefined`)
 *   - throws INVALID_QUERY when `select: []` (a backend never sees an empty
 *     projection list — `SELECT FROM …` and `SELECT * FROM …` are
 *     syntactically distinct, and `findEdges` already covers the latter)
 *   - GET-strategy filter synthesis: `buildEdgeQueryPlan` returns
 *     `{strategy: 'get', docId}` with NO filter list when all three identifying
 *     fields are present. The client must synthesise the equivalent equality
 *     filters so the backend (which only takes filters, not a docId) can hit
 *     the same row.
 *   - QUERY-strategy pass-through: filters and options thread through to
 *     `backend.findEdgesProjected(select, filters, options)` verbatim.
 *   - scan-protection enforcement (`allowCollectionScan: false` is rejected
 *     for an unsafe filter set, just like `findEdges`).
 *
 * Migration is intentionally NOT applied to projected results — the caller
 * asked for a partial shape, and rehydrating it through the migration pipeline
 * would require synthesising every absent field. We pin that here too: any
 * registry/migrations passed to the client never run on the projected rows.
 */

import { describe, expect, it, vi } from 'vitest';

import { GraphClientImpl } from '../../src/client.js';
import type { BackendCapabilities, StorageBackend } from '../../src/internal/backend.js';
import type { Capability, QueryFilter, QueryOptions } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake backend — minimum shape for `GraphClientImpl`. Records every
// `findEdgesProjected` call for assertion.
// ---------------------------------------------------------------------------

interface ProjectedCall {
  select: ReadonlyArray<string>;
  filters: QueryFilter[];
  options?: QueryOptions;
}

interface FakeBackend extends StorageBackend {
  projectedCalls: ProjectedCall[];
  projectedResponse: Array<Record<string, unknown>>;
}

function makeCapabilities(caps: ReadonlySet<Capability>): BackendCapabilities {
  return {
    has: (c: Capability) => caps.has(c),
    values: () => caps.values(),
  };
}

function makeBackend(opts: { withProjection: boolean }): FakeBackend {
  const projectedCalls: ProjectedCall[] = [];
  const backend = {
    capabilities: makeCapabilities(
      new Set<Capability>(
        opts.withProjection
          ? ['core.read', 'core.write', 'query.select']
          : ['core.read', 'core.write'],
      ),
    ),
    collectionPath: 'firegraph',
    scopePath: '',
    projectedCalls,
    projectedResponse: [] as Array<Record<string, unknown>>,
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

  if (opts.withProjection) {
    backend.findEdgesProjected = (
      select: ReadonlyArray<string>,
      filters: QueryFilter[],
      options?: QueryOptions,
    ) => {
      projectedCalls.push({ select, filters, options });
      // Hand back a shallow clone so the caller can't mutate the canned
      // response and surprise the next assertion.
      return Promise.resolve(backend.projectedResponse.map((row) => ({ ...row })));
    };
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphClientImpl.findEdgesProjected — UNSUPPORTED_OPERATION when backend omits projection', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.findEdgesProjected is missing', async () => {
    // Same contract shape as `expand`, `aggregate`, and `bulkDelete`:
    // capability narrowing on the public client surface is purely a
    // type-level fiction (the method is always defined at runtime). The
    // runtime guard inside `findEdgesProjected()` is what closes the gap so
    // a Firestore-without-`query.select` caller hitting the wrong client
    // gets a clean error rather than a `Cannot read property
    // 'findEdgesProjected' of undefined` crash.
    const backend = makeBackend({ withProjection: false });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findEdgesProjected({
        aType: 'tour',
        axbType: 'hasDeparture',
        select: ['title', 'date'] as const,
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('findEdgesProjected()'),
    });

    // Importantly: the runtime guard fires before any backend interaction,
    // so a missing-cap caller doesn't accidentally trip a downstream
    // method that *is* defined (e.g. `query`).
    expect(backend.query).not.toHaveBeenCalled();
  });
});

describe('GraphClientImpl.findEdgesProjected — empty-select rejection', () => {
  it('throws INVALID_QUERY when select is empty', async () => {
    // The backend never sees an empty projection list. `SELECT FROM …` is
    // syntactically distinct from `SELECT * FROM …` — and the latter is
    // what `findEdges` already does. Failing fast at the client surface
    // gives a uniform error across SQLite/DO/Firestore (the SQL backends
    // would otherwise produce a SQLite syntax error; Firestore would
    // produce its own opaque "select() requires at least one field path"
    // failure). The shared error keeps callers from having to discriminate
    // by backend.
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findEdgesProjected({
        aType: 'tour',
        axbType: 'hasDeparture',
        select: [] as const,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('non-empty'),
    });

    // Empty-select short-circuits before the backend call.
    expect(backend.projectedCalls).toHaveLength(0);
  });
});

describe('GraphClientImpl.findEdgesProjected — GET-strategy filter synthesis', () => {
  it('synthesizes equality filters for aUid + axbType + bUid (no aType/bType)', async () => {
    // `buildEdgeQueryPlan` returns `{strategy: 'get', docId}` when all three
    // identifying fields are present, with NO filter list — the original
    // `findEdges` GET path skips the query layer entirely and uses
    // `getDoc(docId)`. Projection has no docId path on the backend
    // contract, so the client must synthesize the equivalent equality
    // filters. This test pins the synthesized shape and that we still
    // dispatch through `findEdgesProjected` (not `getDoc`).
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await client.findEdgesProjected({
      aUid: 'tour-1',
      axbType: 'hasDeparture',
      bUid: 'departure-1',
      select: ['title'] as const,
    });

    expect(backend.projectedCalls).toHaveLength(1);
    expect(backend.projectedCalls[0]?.select).toEqual(['title']);
    // Order matters here only insofar as the backend treats the filter
    // list as an unordered AND set — pinning the order makes the test
    // diffable when the synthesis code changes.
    expect(backend.projectedCalls[0]?.filters).toEqual([
      { field: 'aUid', op: '==', value: 'tour-1' },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'bUid', op: '==', value: 'departure-1' },
    ]);
    // GET strategy never carries query options (orderBy/limit) — synthesised
    // filters preserve that "single-row lookup" intent.
    expect(backend.projectedCalls[0]?.options).toBeUndefined();

    // GET-shape projection MUST NOT route through `getDoc` — the projection
    // contract takes filters, not a docId.
    expect(backend.getDoc).not.toHaveBeenCalled();
  });

  it('also threads aType and bType when present in a GET-shape call', async () => {
    // `aType` / `bType` are optional discriminators on `FindEdgesParams`;
    // when supplied alongside the three identifiers, the client adds them
    // as additional equality filters so the backend's query plan matches
    // the same row `findEdges` would have hit. The order is "core three
    // first, then optional discriminators" — pinned because the backend
    // contract treats it as an AND set, but we still want a stable diff.
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await client.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour-1',
      axbType: 'hasDeparture',
      bType: 'departure',
      bUid: 'departure-1',
      select: ['title', 'date'] as const,
    });

    expect(backend.projectedCalls).toHaveLength(1);
    expect(backend.projectedCalls[0]?.filters).toEqual([
      { field: 'aUid', op: '==', value: 'tour-1' },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'bUid', op: '==', value: 'departure-1' },
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'bType', op: '==', value: 'departure' },
    ]);
  });
});

describe('GraphClientImpl.findEdgesProjected — QUERY-strategy pass-through', () => {
  it('threads filters and options to backend.findEdgesProjected verbatim', async () => {
    // Non-GET shapes go through `buildEdgeQueryPlan` and the client
    // forwards `plan.filters` + `plan.options` unchanged. Same pass-through
    // shape as `expand`: the backend owns all SQL/Pipeline translation;
    // the client never inspects the payload.
    const backend = makeBackend({ withProjection: true });
    backend.projectedResponse = [
      { title: 'Trip A', date: '2025-01-01' },
      { title: 'Trip B', date: '2025-02-01' },
    ];
    const client = new GraphClientImpl(backend);

    const out = await client.findEdgesProjected({
      aType: 'tour',
      axbType: 'hasDeparture',
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 10,
      select: ['title', 'date'] as const,
    });

    expect(out).toEqual([
      { title: 'Trip A', date: '2025-01-01' },
      { title: 'Trip B', date: '2025-02-01' },
    ]);

    expect(backend.projectedCalls).toHaveLength(1);
    expect(backend.projectedCalls[0]?.select).toEqual(['title', 'date']);
    // `aType` + `axbType` produce two equality filters in
    // `buildEdgeQueryPlan`; the client forwards them as-is.
    expect(backend.projectedCalls[0]?.filters).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
    ]);
    expect(backend.projectedCalls[0]?.options).toEqual({
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 10,
    });
  });

  it('forwards `where` clauses alongside identifying filters', async () => {
    // Mixed shape — identifying fields plus a custom `where`. The plan
    // builder concatenates them; the client forwards the merged list.
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await client.findEdgesProjected({
      aType: 'tour',
      axbType: 'hasDeparture',
      where: [{ field: 'data.status', op: '==', value: 'published' }],
      select: ['title'] as const,
    });

    expect(backend.projectedCalls).toHaveLength(1);
    expect(backend.projectedCalls[0]?.filters).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'data.status', op: '==', value: 'published' },
    ]);
  });
});

describe('GraphClientImpl.findEdgesProjected — scan protection', () => {
  it('throws QuerySafetyError when the filter set is unsafe and allowCollectionScan is not set', async () => {
    // A bare `where`-only filter on a non-indexed field is the canonical
    // unsafe shape. Without `allowCollectionScan: true`, the client must
    // refuse the query just as `findEdges` does. This is the single place
    // we verify the projection path inherits scan protection (the safety
    // analyser itself is covered by `query-safety.test.ts`).
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.findEdgesProjected({
        where: [{ field: 'data.status', op: '==', value: 'published' }],
        select: ['title'] as const,
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });

    // Safety check fires before backend dispatch.
    expect(backend.projectedCalls).toHaveLength(0);
  });

  it('honours allowCollectionScan: true as an explicit opt-in', async () => {
    // The opt-in escape hatch must let an otherwise-unsafe query through.
    // Same contract as `findEdges` / `aggregate` / `bulkDelete`.
    const backend = makeBackend({ withProjection: true });
    const client = new GraphClientImpl(backend);

    await client.findEdgesProjected({
      where: [{ field: 'data.status', op: '==', value: 'published' }],
      select: ['title'] as const,
      allowCollectionScan: true,
    });

    expect(backend.projectedCalls).toHaveLength(1);
    expect(backend.projectedCalls[0]?.filters).toEqual([
      { field: 'data.status', op: '==', value: 'published' },
    ]);
  });
});

describe('GraphClientImpl.findEdgesProjected — bypasses migration pipeline', () => {
  it('returns backend rows verbatim and never invokes any registry-bound migration', async () => {
    // A stored migration on `(tour, hasDeparture, departure)` would, on a
    // full-record read, run during `applyMigrations` and rewrite the row.
    // Projection bypasses that pipeline — see the JSDoc on
    // `StorageBackend.findEdgesProjected` and `SelectExtension`. The
    // partial shape can't be safely rehydrated through migration without
    // synthesising every absent field, so the backend's projection result
    // flows through unchanged. This test pins that behaviour even when a
    // matching registry entry is present on the client.
    const backend = makeBackend({ withProjection: true });
    backend.projectedResponse = [{ title: 'Trip A' }];

    const migrationSpy = vi.fn((d: Record<string, unknown>) => ({ ...d, migrated: true }));
    const client = new GraphClientImpl(backend, {
      registry: {
        validate: () => undefined,
        lookup: () => ({
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          schemaVersion: 1,
          migrations: [{ fromVersion: 0, toVersion: 1, up: migrationSpy }],
        }),
        lookupByAxbType: () => [],
        getSubgraphTopology: () => [],
        entries: () => [],
      },
    });

    const out = await client.findEdgesProjected({
      aType: 'tour',
      axbType: 'hasDeparture',
      select: ['title'] as const,
    });

    expect(out).toEqual([{ title: 'Trip A' }]);
    // Migration must NOT have been invoked — the projection is a partial
    // shape, and forcing it through the migration pipeline would be a bug.
    expect(migrationSpy).not.toHaveBeenCalled();
  });
});
