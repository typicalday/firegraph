/**
 * Unit tests for `GraphClientImpl.bulkDelete()` / `GraphClientImpl.bulkUpdate()`
 * — the public client surface that fronts every backend's `query.dml`
 * implementation.
 *
 * Per-backend SQL/RPC translation lives in `sqlite-backend.test.ts`,
 * `cloudflare-sql.test.ts`, and `cloudflare-backend.test.ts`. This file
 * pins the *client-side* contract:
 *
 *   - throws UNSUPPORTED_OPERATION when the backend lacks the DML method
 *   - rejects a get-strategy spec (all three identifiers) with INVALID_QUERY,
 *     because a single-doc lookup should go through the regular write path
 *   - applies scan-protection like every other query path
 *   - accepts a zero-filter DML (delete/update everything) when the caller
 *     opts in via `allowCollectionScan: true` — same I2-style guard as
 *     `aggregate`
 *   - threads filters and the `BulkUpdatePatch` through unchanged
 */

import { describe, expect, it, vi } from 'vitest';

import { GraphClientImpl } from '../../src/client.js';
import type { BackendCapabilities, StorageBackend } from '../../src/internal/backend.js';
import type {
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  Capability,
  QueryFilter,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake backend — implements just enough of `StorageBackend` to keep
// `GraphClientImpl` happy. The interesting behaviour is bulkDelete/bulkUpdate.
// ---------------------------------------------------------------------------

interface FakeBackend extends StorageBackend {
  bulkDeleteCalls: Array<{ filters: QueryFilter[]; options?: BulkOptions }>;
  bulkUpdateCalls: Array<{
    filters: QueryFilter[];
    patch: BulkUpdatePatch;
    options?: BulkOptions;
  }>;
  bulkResponse: BulkResult;
}

function makeCapabilities(caps: ReadonlySet<Capability>): BackendCapabilities {
  return {
    has: (c: Capability) => caps.has(c),
    values: () => caps.values(),
  };
}

function makeBackend(opts: { withDml: boolean }): FakeBackend {
  const bulkDeleteCalls: FakeBackend['bulkDeleteCalls'] = [];
  const bulkUpdateCalls: FakeBackend['bulkUpdateCalls'] = [];
  const backend = {
    capabilities: makeCapabilities(
      new Set<Capability>(
        opts.withDml ? ['core.read', 'core.write', 'query.dml'] : ['core.read', 'core.write'],
      ),
    ),
    collectionPath: 'firegraph',
    scopePath: '',
    bulkDeleteCalls,
    bulkUpdateCalls,
    bulkResponse: { deleted: 0, batches: 1, errors: [] } as BulkResult,
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

  if (opts.withDml) {
    backend.bulkDelete = (filters, options) => {
      bulkDeleteCalls.push({ filters, options });
      return Promise.resolve({ ...backend.bulkResponse });
    };
    backend.bulkUpdate = (filters, patch, options) => {
      bulkUpdateCalls.push({ filters, patch, options });
      return Promise.resolve({ ...backend.bulkResponse });
    };
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Tests — bulkDelete
// ---------------------------------------------------------------------------

describe('GraphClientImpl.bulkDelete — UNSUPPORTED_OPERATION when backend omits the method', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.bulkDelete is missing', async () => {
    // The capability gate is type-level on the public client; at runtime
    // the GraphClient.bulkDelete method is always present (the conditional
    // narrowing is purely TS), so we still need an explicit runtime guard.
    const backend = makeBackend({ withDml: false });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkDelete({
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('bulkDelete'),
    });
  });
});

describe('GraphClientImpl.bulkDelete — query strategy enforcement', () => {
  it('rejects a get-strategy spec (all three identifiers present) with INVALID_QUERY', async () => {
    // `findEdges` with all three identifiers (aUid, axbType, bUid) becomes
    // a single doc lookup. Bulk DML is the wrong tool for that — callers
    // should use `removeEdge` directly. Reject so the caller fixes the spec.
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkDelete({
        aUid: 'kX1nQ2mP9xR4wL1tY8s3a',
        axbType: 'hasDeparture',
        bUid: 'kX1nQ2mP9xR4wL1tY8s3b',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('direct document lookup'),
    });
    expect(backend.bulkDeleteCalls).toHaveLength(0);
  });

  it('forwards filtered specs to backend.bulkDelete with the planned filter list', async () => {
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 7, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const out = await client.bulkDelete({
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
    });

    expect(out).toEqual({ deleted: 7, batches: 1, errors: [] });
    expect(backend.bulkDeleteCalls).toHaveLength(1);
    // The plan emits `aType`, `axbType`, `bType` filters in that order.
    expect(backend.bulkDeleteCalls[0].filters).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'bType', op: '==', value: 'tour' },
    ]);
  });
});

describe('GraphClientImpl.bulkDelete — scan protection', () => {
  it('throws QuerySafetyError when the planned filters do not match a safe index pattern', async () => {
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkDelete({
        aType: 'tour',
        // No axbType / bUid → not a safe index pattern.
      }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.bulkDeleteCalls).toHaveLength(0);
  });

  it('honours allowCollectionScan: true to bypass scan protection', async () => {
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 3, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const out = await client.bulkDelete({
      aType: 'tour',
      allowCollectionScan: true,
    });

    expect(out).toEqual({ deleted: 3, batches: 1, errors: [] });
    expect(backend.bulkDeleteCalls).toHaveLength(1);
  });

  it('accepts an unfiltered bulkDelete (DELETE everything) with allowCollectionScan: true', async () => {
    // Symmetry with aggregate: bulk DML must allow zero-filter plans for
    // the canonical "wipe everything in this scope" use case.
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 42, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const out = await client.bulkDelete({ allowCollectionScan: true });

    expect(out).toEqual({ deleted: 42, batches: 1, errors: [] });
    expect(backend.bulkDeleteCalls).toHaveLength(1);
    expect(backend.bulkDeleteCalls[0].filters).toEqual([]);
  });

  it('rejects unfiltered bulkDelete without allowCollectionScan', async () => {
    // A delete-everything from a careless typo must still be caught.
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(client.bulkDelete({})).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.bulkDeleteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — bulkUpdate
// ---------------------------------------------------------------------------

describe('GraphClientImpl.bulkUpdate — UNSUPPORTED_OPERATION when backend omits the method', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.bulkUpdate is missing', async () => {
    const backend = makeBackend({ withDml: false });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkUpdate(
        { aType: 'tour', axbType: 'is', bType: 'tour' },
        { data: { status: 'archived' } },
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('bulkUpdate'),
    });
  });
});

describe('GraphClientImpl.bulkUpdate — query strategy enforcement', () => {
  it('rejects a get-strategy spec (all three identifiers present) with INVALID_QUERY', async () => {
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkUpdate(
        {
          aUid: 'kX1nQ2mP9xR4wL1tY8s3a',
          axbType: 'hasDeparture',
          bUid: 'kX1nQ2mP9xR4wL1tY8s3b',
        },
        { data: { status: 'archived' } },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('direct document lookup'),
    });
    expect(backend.bulkUpdateCalls).toHaveLength(0);
  });

  it('forwards filtered specs and the patch to backend.bulkUpdate unchanged', async () => {
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 5, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const patch: BulkUpdatePatch = { data: { status: 'archived', tier: 'gold' } };
    const out = await client.bulkUpdate({ aType: 'tour', axbType: 'is', bType: 'tour' }, patch);

    expect(out).toEqual({ deleted: 5, batches: 1, errors: [] });
    expect(backend.bulkUpdateCalls).toHaveLength(1);
    expect(backend.bulkUpdateCalls[0].filters).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'bType', op: '==', value: 'tour' },
    ]);
    // Patch passes through unchanged — the deep-merge happens inside the
    // backend's compileBulkUpdate via flattenPatch.
    expect(backend.bulkUpdateCalls[0].patch).toEqual(patch);
  });
});

describe('GraphClientImpl.bulkUpdate — scan protection', () => {
  it('throws QuerySafetyError when the planned filters do not match a safe index pattern', async () => {
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(
      client.bulkUpdate({ aType: 'tour' }, { data: { status: 'archived' } }),
    ).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.bulkUpdateCalls).toHaveLength(0);
  });

  it('honours allowCollectionScan: true to bypass scan protection', async () => {
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 11, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const out = await client.bulkUpdate(
      { aType: 'tour', allowCollectionScan: true },
      { data: { status: 'archived' } },
    );

    expect(out).toEqual({ deleted: 11, batches: 1, errors: [] });
    expect(backend.bulkUpdateCalls).toHaveLength(1);
  });

  it('accepts an unfiltered bulkUpdate (UPDATE everything) with allowCollectionScan: true', async () => {
    const backend = makeBackend({ withDml: true });
    backend.bulkResponse = { deleted: 100, batches: 1, errors: [] };
    const client = new GraphClientImpl(backend);

    const out = await client.bulkUpdate(
      { allowCollectionScan: true },
      { data: { archived: true } },
    );

    expect(out).toEqual({ deleted: 100, batches: 1, errors: [] });
    expect(backend.bulkUpdateCalls).toHaveLength(1);
    expect(backend.bulkUpdateCalls[0].filters).toEqual([]);
  });

  it('rejects unfiltered bulkUpdate without allowCollectionScan', async () => {
    const backend = makeBackend({ withDml: true });
    const client = new GraphClientImpl(backend);

    await expect(client.bulkUpdate({}, { data: { status: 'archived' } })).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    expect(backend.bulkUpdateCalls).toHaveLength(0);
  });
});
