/**
 * Unit tests for `GraphClientImpl.expand()` — the public client surface
 * that fronts every backend's `expand(...)` implementation (Phase 6,
 * capability `query.join`).
 *
 * The per-backend translation (SQLite SQL `IN (?, …)`, DO RPC) is covered
 * by `sqlite-backend.test.ts` and `cloudflare-sql.test.ts`. This file
 * pins the *client-side* contract:
 *
 *   - throws UNSUPPORTED_OPERATION when the backend lacks `expand`
 *     (Firestore today; capability narrowing is a TS-time fiction, runtime
 *     guard is what makes the cap-less fallback story sound)
 *   - short-circuits empty `sources: []` to a structural empty result
 *     without touching the backend, in both hydrate=false and hydrate=true
 *     shapes
 *   - threads non-empty params through to `backend.expand(...)` verbatim
 *     (no client-side filter projection — that's the backend's job)
 *   - threads the `ExpandResult` shape back unchanged in both forms
 */

import { describe, expect, it, vi } from 'vitest';

import { GraphClientImpl } from '../../src/client.js';
import type { BackendCapabilities, StorageBackend } from '../../src/internal/backend.js';
import type { Capability, ExpandParams, ExpandResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake backend — minimum shape for `GraphClientImpl`. Records every
// `expand` call for assertion.
// ---------------------------------------------------------------------------

interface FakeBackend extends StorageBackend {
  expandCalls: ExpandParams[];
  expandResponse: ExpandResult;
}

function makeCapabilities(caps: ReadonlySet<Capability>): BackendCapabilities {
  return {
    has: (c: Capability) => caps.has(c),
    values: () => caps.values(),
  };
}

function makeBackend(opts: { withExpand: boolean }): FakeBackend {
  const expandCalls: ExpandParams[] = [];
  const backend = {
    capabilities: makeCapabilities(
      new Set<Capability>(
        opts.withExpand ? ['core.read', 'core.write', 'query.join'] : ['core.read', 'core.write'],
      ),
    ),
    collectionPath: 'firegraph',
    scopePath: '',
    expandCalls,
    expandResponse: { edges: [] } as ExpandResult,
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

  if (opts.withExpand) {
    backend.expand = (params: ExpandParams) => {
      expandCalls.push(params);
      // Hand back a shallow clone so the caller can't mutate the canned
      // response and surprise the next assertion.
      return Promise.resolve(
        backend.expandResponse.targets
          ? {
              edges: [...backend.expandResponse.edges],
              targets: [...backend.expandResponse.targets],
            }
          : { edges: [...backend.expandResponse.edges] },
      );
    };
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphClientImpl.expand — UNSUPPORTED_OPERATION when backend omits expand', () => {
  it('throws with code UNSUPPORTED_OPERATION when backend.expand is missing', async () => {
    // Same contract shape as `aggregate` and `bulkDelete`: capability
    // narrowing on the public client surface is purely a type-level
    // fiction (the method is always defined at runtime). The runtime
    // guard inside `expand()` is what closes the gap so a Firestore-only
    // caller hitting the wrong client gets a clean error rather than a
    // `Cannot read property 'expand' of undefined` crash.
    const backend = makeBackend({ withExpand: false });
    const client = new GraphClientImpl(backend);

    await expect(client.expand({ sources: ['a', 'b'], axbType: 'wrote' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('expand()'),
    });
  });
});

describe('GraphClientImpl.expand — empty source short-circuit', () => {
  it('short-circuits empty sources to { edges: [] } without touching the backend', async () => {
    // `compileExpand` rejects empty source lists because `IN ()` is
    // invalid SQL. The client must intercept before the call so traversal
    // callers — which discover empty source sets organically (e.g. a hop
    // that produced zero edges) — don't have to special-case the call
    // site themselves.
    const backend = makeBackend({ withExpand: true });
    const client = new GraphClientImpl(backend);

    const out = await client.expand({ sources: [], axbType: 'wrote' });
    expect(out).toEqual({ edges: [] });
    expect(backend.expandCalls).toHaveLength(0);
  });

  it('short-circuits empty sources with hydrate: true to { edges: [], targets: [] }', async () => {
    // Hydrate-mode short-circuit must surface the `targets: []` shape so
    // callers that destructure `out.targets` still get a defined array
    // (rather than `undefined`). Mirrors the contract test added in the
    // `cloudflare-sql.test.ts` and `sqlite-backend.test.ts` suites.
    const backend = makeBackend({ withExpand: true });
    const client = new GraphClientImpl(backend);

    const out = await client.expand({
      sources: [],
      axbType: 'wrote',
      hydrate: true,
    });
    expect(out).toEqual({ edges: [], targets: [] });
    expect(backend.expandCalls).toHaveLength(0);
  });
});

describe('GraphClientImpl.expand — backend dispatch', () => {
  it('forwards non-empty params to backend.expand verbatim', async () => {
    // The client is a thin pass-through. No filter projection, no
    // capability re-check, no payload massage — the backend owns all
    // that. The pass-through shape lock is what lets the SQL layer add
    // new params (e.g. `direction`, `limitPerSource`) without touching
    // the client.
    const backend = makeBackend({ withExpand: true });
    backend.expandResponse = {
      edges: [
        {
          aType: 'agent',
          aUid: 'a',
          axbType: 'wrote',
          bType: 'note',
          bUid: 't1',
          data: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const client = new GraphClientImpl(backend);

    const out = await client.expand({
      sources: ['a', 'b'],
      axbType: 'wrote',
      direction: 'forward',
      limitPerSource: 10,
    });

    expect(out.edges).toHaveLength(1);
    expect(backend.expandCalls).toHaveLength(1);
    expect(backend.expandCalls[0]).toEqual({
      sources: ['a', 'b'],
      axbType: 'wrote',
      direction: 'forward',
      limitPerSource: 10,
    });
  });

  it('threads the hydrate-mode result shape (edges + aligned targets) through unchanged', async () => {
    const backend = makeBackend({ withExpand: true });
    backend.expandResponse = {
      edges: [
        {
          aType: 'agent',
          aUid: 'a',
          axbType: 'wrote',
          bType: 'note',
          bUid: 't1',
          data: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      targets: [
        {
          aType: 'note',
          aUid: 't1',
          axbType: 'is',
          bType: 'note',
          bUid: 't1',
          data: { title: 'first' },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    };
    const client = new GraphClientImpl(backend);

    const out = await client.expand({
      sources: ['a'],
      axbType: 'wrote',
      hydrate: true,
    });

    expect(out.edges).toHaveLength(1);
    expect(out.targets).toHaveLength(1);
    // Index alignment is a backend contract — the client never touches it.
    expect(out.targets![0]?.bUid).toBe(out.edges[0]!.bUid);
  });
});
