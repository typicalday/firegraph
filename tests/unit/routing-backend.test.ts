/**
 * Unit tests for `createRoutingBackend`.
 *
 * These tests use a small in-memory mock `StorageBackend` that records every
 * call. We don't need a real SQL engine here — the routing wrapper is
 * logic-only and its responsibility is confined to:
 *
 *   1. Invoking the caller's `route` callback on every `subgraph()` call
 *      with the right `RoutingContext` values, notably the materialized
 *      `storageScope` string (interleaved `<uid>/<name>` pairs).
 *   2. Using the routed backend when the callback returns one, the base
 *      backend when it returns null, and always re-wrapping the child so
 *      that nested `.subgraph()` calls on either path keep routing.
 *   3. Delegating every non-subgraph operation (`getDoc`, `query`, `setDoc`,
 *      `runTransaction`, etc.) to the base backend unchanged.
 *   4. Rejecting malformed subgraph arguments (`''` / `'/'`) up front, as
 *      defense-in-depth matching `GraphClient.subgraph()` and
 *      `SqliteBackendImpl.subgraph()`.
 */

import { describe, expect, it, vi } from 'vitest';

import { FiregraphError } from '../../src/errors.js';
import type {
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
} from '../../src/internal/backend.js';
import { createRoutingBackend, type RoutingContext } from '../../src/internal/routing-backend.js';
import type {
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../../src/types.js';

/**
 * Fluent mock — records calls on itself and on any child created via
 * `subgraph()`. The returned `StorageBackend` is intentionally minimal:
 * reads/queries return empty results and writes are no-ops. For tests that
 * need to assert on arguments, inspect `backend.calls`.
 */
interface MockCall {
  method: string;
  args: unknown[];
}

interface MockBackend extends StorageBackend {
  readonly calls: MockCall[];
  readonly children: MockBackend[];
  // `runTransaction` / `createBatch` spies exposed for direct assertion.
  readonly txFn: TransactionBackend;
  readonly batch: BatchBackend;
}

function createMockBackend(
  id: string,
  scopePath: string = '',
  collectionPath: string = 'mock',
): MockBackend {
  const calls: MockCall[] = [];
  const children: MockBackend[] = [];

  const txFn: TransactionBackend = {
    async getDoc() {
      return null;
    },
    async query() {
      return [];
    },
    async setDoc() {
      /* no-op */
    },
    async updateDoc() {
      /* no-op */
    },
    async deleteDoc() {
      /* no-op */
    },
  };
  const batch: BatchBackend = {
    setDoc() {
      /* no-op */
    },
    updateDoc() {
      /* no-op */
    },
    deleteDoc() {
      /* no-op */
    },
    async commit() {
      /* no-op */
    },
  };

  const backend: MockBackend = {
    collectionPath,
    scopePath,
    calls,
    children,
    txFn,
    batch,

    async getDoc(docId: string): Promise<StoredGraphRecord | null> {
      calls.push({ method: 'getDoc', args: [docId] });
      return null;
    },
    async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
      calls.push({ method: 'query', args: [filters, options] });
      return [];
    },
    async setDoc(docId: string, record: WritableRecord): Promise<void> {
      calls.push({ method: 'setDoc', args: [docId, record] });
    },
    async updateDoc(docId: string, update: UpdatePayload): Promise<void> {
      calls.push({ method: 'updateDoc', args: [docId, update] });
    },
    async deleteDoc(docId: string): Promise<void> {
      calls.push({ method: 'deleteDoc', args: [docId] });
    },
    async runTransaction<T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
      calls.push({ method: 'runTransaction', args: [] });
      return fn(txFn);
    },
    createBatch(): BatchBackend {
      calls.push({ method: 'createBatch', args: [] });
      return batch;
    },
    subgraph(parentUid: string, name: string): StorageBackend {
      calls.push({ method: 'subgraph', args: [parentUid, name] });
      const childScope = scopePath ? `${scopePath}/${name}` : name;
      const child = createMockBackend(`${id}.${parentUid}.${name}`, childScope, collectionPath);
      children.push(child);
      return child;
    },
    async removeNodeCascade(
      uid: string,
      _reader: GraphReader,
      options?: BulkOptions,
    ): Promise<CascadeResult> {
      calls.push({ method: 'removeNodeCascade', args: [uid, options] });
      return { deleted: 0, batches: 0, errors: [], edgesDeleted: 0, nodeDeleted: false };
    },
    async bulkRemoveEdges(
      params: FindEdgesParams,
      _reader: GraphReader,
      options?: BulkOptions,
    ): Promise<BulkResult> {
      calls.push({ method: 'bulkRemoveEdges', args: [params, options] });
      return { deleted: 0, batches: 0, errors: [] };
    },
    async findEdgesGlobal(
      params: FindEdgesParams,
      collectionName?: string,
    ): Promise<StoredGraphRecord[]> {
      calls.push({ method: 'findEdgesGlobal', args: [params, collectionName] });
      return [];
    },
  };
  return backend;
}

const emptyReader: GraphReader = {
  async getNode() {
    return null;
  },
  async getEdge() {
    return null;
  },
  async edgeExists() {
    return false;
  },
  async findEdges() {
    return [];
  },
  async findNodes() {
    return [];
  },
};

describe('createRoutingBackend — route() invocation', () => {
  it('invokes the route callback with the child scope path and storage scope', () => {
    const base = createMockBackend('base');
    const route = vi.fn<(ctx: RoutingContext) => StorageBackend | null>().mockReturnValue(null);
    const router = createRoutingBackend(base, { route });

    router.subgraph('A', 'memories');

    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith({
      parentUid: 'A',
      subgraphName: 'memories',
      scopePath: 'memories',
      storageScope: 'A/memories',
    });
  });

  it('builds correct scope/storage paths for nested subgraphs', () => {
    const base = createMockBackend('base');
    const seen: RoutingContext[] = [];
    const router = createRoutingBackend(base, {
      route: (ctx) => {
        seen.push(ctx);
        return null;
      },
    });

    const mid = router.subgraph('A', 'memories');
    mid.subgraph('B', 'context');

    expect(seen).toEqual([
      {
        parentUid: 'A',
        subgraphName: 'memories',
        scopePath: 'memories',
        storageScope: 'A/memories',
      },
      {
        parentUid: 'B',
        subgraphName: 'context',
        scopePath: 'memories/context',
        storageScope: 'A/memories/B/context',
      },
    ]);
  });
});

describe('createRoutingBackend — null route falls through to base', () => {
  it("uses the base backend's subgraph() when route returns null", () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    router.subgraph('A', 'memories');

    const subgraphCalls = base.calls.filter((c) => c.method === 'subgraph');
    expect(subgraphCalls).toHaveLength(1);
    expect(subgraphCalls[0].args).toEqual(['A', 'memories']);
  });

  it("uses the base's subgraph() when route returns undefined", () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, {
      route: () => undefined as unknown as StorageBackend | null,
    });

    router.subgraph('A', 'memories');

    expect(base.calls.some((c) => c.method === 'subgraph')).toBe(true);
  });

  it('keeps routing in effect for grandchildren after a pass-through', () => {
    const base = createMockBackend('base');
    const routeSpy = vi.fn<(ctx: RoutingContext) => StorageBackend | null>().mockReturnValue(null);
    const router = createRoutingBackend(base, { route: routeSpy });

    const mid = router.subgraph('A', 'memories');
    mid.subgraph('B', 'context');

    // Route should have been consulted for both levels.
    expect(routeSpy).toHaveBeenCalledTimes(2);
  });
});

describe('createRoutingBackend — non-null route swaps the backend', () => {
  it('returns the routed backend (wrapped) when route returns one', async () => {
    const base = createMockBackend('base');
    const routed = createMockBackend('routed', 'memories');
    const router = createRoutingBackend(base, {
      route: ({ subgraphName }) => (subgraphName === 'memories' ? routed : null),
    });

    const child = router.subgraph('A', 'memories');

    // Base's subgraph() was NOT called — the router swapped before
    // descending into the base.
    expect(base.calls.find((c) => c.method === 'subgraph')).toBeUndefined();

    // Reads on the child go to the routed backend.
    await child.getDoc('some-id');
    expect(routed.calls.find((c) => c.method === 'getDoc')).toBeDefined();
  });

  it('continues routing on grandchildren of a routed child', () => {
    const base = createMockBackend('base');
    const routed = createMockBackend('routed', 'memories');
    const seen: RoutingContext[] = [];
    const router = createRoutingBackend(base, {
      route: (ctx) => {
        seen.push(ctx);
        return ctx.subgraphName === 'memories' ? routed : null;
      },
    });

    const mid = router.subgraph('A', 'memories');
    mid.subgraph('B', 'context');

    // Both levels were consulted.
    expect(seen).toHaveLength(2);

    // The storage-scope of the grandchild continues to interleave even
    // though the mid-level was routed to another backend. This is the
    // contract: storage-scope reflects the *logical* path, not where
    // the data physically lives.
    expect(seen[1]).toEqual({
      parentUid: 'B',
      subgraphName: 'context',
      scopePath: 'memories/context',
      storageScope: 'A/memories/B/context',
    });
  });

  it('preserves the logical scopePath even when the routed backend has an empty scopePath', () => {
    // Regression test for the bug where the wrapper inherited
    // `scopePath` from the routed backend's own `.scopePath`. In practice
    // a freshly-minted per-DO backend's `scopePath` is `''` — it has no
    // knowledge of the caller's logical chain — so reading from
    // `base.scopePath` loses the path. The wrapper must track the
    // logical scope independently.
    const base = createMockBackend('base');
    const routed = createMockBackend('routed', '' /* fresh DO root */);
    const seen: RoutingContext[] = [];
    const router = createRoutingBackend(base, {
      route: (ctx) => {
        seen.push(ctx);
        return ctx.subgraphName === 'memories' ? routed : null;
      },
    });

    const mid = router.subgraph('A', 'memories');
    // The wrapper exposes the logical scope to clients, not the
    // (empty) scope of the wrapped routed backend.
    expect(mid.scopePath).toBe('memories');

    mid.subgraph('B', 'context');

    // Grandchild's context still has the full logical chain even though
    // the routed backend itself reported scopePath=''.
    expect(seen[1]).toEqual({
      parentUid: 'B',
      subgraphName: 'context',
      scopePath: 'memories/context',
      storageScope: 'A/memories/B/context',
    });
  });
});

describe('createRoutingBackend — pass-through delegation', () => {
  it('delegates reads to the base backend', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    await router.getDoc('doc-1');
    await router.query([{ field: 'aType', op: '==', value: 'tour' }]);

    expect(base.calls.map((c) => c.method)).toEqual(['getDoc', 'query']);
  });

  it('delegates writes to the base backend', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    const rec: WritableRecord = {
      aType: 't',
      aUid: 'x',
      axbType: 'is',
      bType: 't',
      bUid: 'x',
      data: {},
    };
    await router.setDoc('x', rec);
    await router.updateDoc('x', { dataFields: { k: 1 } });
    await router.deleteDoc('x');

    expect(base.calls.map((c) => c.method)).toEqual(['setDoc', 'updateDoc', 'deleteDoc']);
  });

  it('delegates runTransaction to the base backend', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    let txReceived: TransactionBackend | null = null;
    await router.runTransaction(async (tx) => {
      txReceived = tx;
    });

    expect(base.calls.find((c) => c.method === 'runTransaction')).toBeDefined();
    // The TransactionBackend exposed has no `subgraph()` method — the
    // type system enforces that routing can't happen inside a transaction.
    // This assertion is mostly documentation.
    expect(txReceived).toBe(base.txFn);
    expect((txReceived as unknown as { subgraph?: unknown })?.subgraph).toBeUndefined();
  });

  it('delegates createBatch to the base backend', () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    const batch = router.createBatch();
    expect(base.calls.find((c) => c.method === 'createBatch')).toBeDefined();
    // Same contract as transactions: no `subgraph()` on BatchBackend.
    expect((batch as unknown as { subgraph?: unknown }).subgraph).toBeUndefined();
  });

  it('delegates removeNodeCascade and bulkRemoveEdges to the base', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    await router.removeNodeCascade('uid-1', emptyReader);
    await router.bulkRemoveEdges({ aUid: 'uid-1' }, emptyReader);

    expect(base.calls.map((c) => c.method)).toEqual(['removeNodeCascade', 'bulkRemoveEdges']);
  });

  it('delegates findEdgesGlobal to the base backend', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    await router.findEdgesGlobal?.({ aUid: 'uid-1' });
    expect(base.calls.find((c) => c.method === 'findEdgesGlobal')).toBeDefined();
  });

  it('omits findEdgesGlobal on the router when the base backend omits it', () => {
    const base = createMockBackend('base');
    // Strip the optional method *before* constructing the router, so we
    // simulate a backend driver that never implemented it (e.g. some
    // SQLite drivers). Feature detection via `typeof` should reflect the
    // base's capability.
    (base as { findEdgesGlobal?: unknown }).findEdgesGlobal = undefined;
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.findEdgesGlobal).toBeUndefined();
    expect(typeof router.findEdgesGlobal).toBe('undefined');
  });

  it('exposes the base backend collectionPath and scopePath', () => {
    const base = createMockBackend('base', 'memories', 'myTable');
    const router = createRoutingBackend(base, { route: () => null });
    expect(router.collectionPath).toBe('myTable');
    expect(router.scopePath).toBe('memories');
  });
});

describe('createRoutingBackend — input validation', () => {
  it('rejects a subgraph() call with empty parentUid', () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(() => router.subgraph('', 'memories')).toThrow(FiregraphError);
    expect(() => router.subgraph('', 'memories')).toThrow(/INVALID_SUBGRAPH|parentNodeUid/);
  });

  it('rejects a subgraph() call with "/" in parentUid', () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(() => router.subgraph('A/B', 'memories')).toThrow(/INVALID_SUBGRAPH|parentNodeUid/);
  });

  it('rejects a subgraph() call with "/" in name', () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(() => router.subgraph('A', 'mem/ories')).toThrow(/INVALID_SUBGRAPH|Subgraph name/);
  });

  it('rejects a subgraph() call with empty name', () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(() => router.subgraph('A', '')).toThrow(/INVALID_SUBGRAPH|Subgraph name/);
  });

  it('rejects a createRoutingBackend call with no route function', () => {
    const base = createMockBackend('base');
    expect(() =>
      createRoutingBackend(base, {
        route: undefined as unknown as (ctx: RoutingContext) => StorageBackend | null,
      }),
    ).toThrow(/INVALID_ARGUMENT|route/);
  });
});
