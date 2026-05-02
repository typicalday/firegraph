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
  WriteMode,
} from '../../src/internal/backend.js';
import { createCapabilities } from '../../src/internal/backend.js';
import { createRoutingBackend, type RoutingContext } from '../../src/internal/routing-backend.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
import type {
  AggregateSpec,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  Capability,
  CascadeResult,
  ExpandParams,
  ExpandResult,
  FindEdgesParams,
  FindNearestParams,
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
    capabilities: createCapabilities(
      new Set<Capability>([
        'core.read',
        'core.write',
        'core.batch',
        'core.subgraph',
        'query.aggregate',
        'query.dml',
        'query.join',
        'query.select',
        'search.vector',
      ]),
    ),
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
    async setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
      calls.push({ method: 'setDoc', args: [docId, record, mode] });
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
    async aggregate(spec: AggregateSpec, filters: QueryFilter[]): Promise<Record<string, number>> {
      calls.push({ method: 'aggregate', args: [spec, filters] });
      // Return one zero per alias — the empty-set canonical shape that
      // every backend produces for an unfiltered aggregate over no rows.
      const out: Record<string, number> = {};
      for (const alias of Object.keys(spec)) out[alias] = 0;
      return out;
    },
    async bulkDelete(filters: QueryFilter[], options?: BulkOptions): Promise<BulkResult> {
      calls.push({ method: 'bulkDelete', args: [filters, options] });
      // Return the canonical "no-rows-touched" shape every DML backend
      // produces when a server-side DELETE matches zero rows.
      return { deleted: 0, batches: 1, errors: [] };
    },
    async bulkUpdate(
      filters: QueryFilter[],
      patch: BulkUpdatePatch,
      options?: BulkOptions,
    ): Promise<BulkResult> {
      calls.push({ method: 'bulkUpdate', args: [filters, patch, options] });
      return { deleted: 0, batches: 1, errors: [] };
    },
    async expand(params: ExpandParams): Promise<ExpandResult> {
      calls.push({ method: 'expand', args: [params] });
      // Return the canonical empty-result shape — the routing wrapper
      // never inspects the payload, so a structural empty is enough.
      return params.hydrate ? { edges: [], targets: [] } : { edges: [] };
    },
    async findEdgesProjected(
      select: ReadonlyArray<string>,
      filters: QueryFilter[],
      options?: QueryOptions,
    ): Promise<Array<Record<string, unknown>>> {
      calls.push({ method: 'findEdgesProjected', args: [select, filters, options] });
      // Canonical empty-result shape — the routing wrapper never inspects
      // the payload, so a structural empty is enough.
      return [];
    },
    async findNearest(params: FindNearestParams): Promise<StoredGraphRecord[]> {
      calls.push({ method: 'findNearest', args: [params] });
      // Canonical empty-result shape — the routing wrapper never inspects
      // the payload, so a structural empty is enough.
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
    await router.setDoc('x', rec, 'replace');
    await router.updateDoc('x', { dataOps: flattenPatch({ k: 1 }) });
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

  it('delegates aggregate to the base backend when the base declares query.aggregate', async () => {
    // Mirror of the findEdgesGlobal install/omit pair: when the base backend
    // ships an `aggregate(...)` method (and declares `query.aggregate` in its
    // capability set), the router must surface a callable `aggregate` and
    // forward to the base. Same rationale as findEdgesGlobal — feature
    // detection via `typeof router.aggregate` is the documented contract.
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.aggregate).toBe('function');
    const out = await router.aggregate!({ n: { op: 'count' } }, [
      { field: 'aType', op: '==', value: 'tour' },
    ]);
    expect(out).toEqual({ n: 0 });
    const aggCall = base.calls.find((c) => c.method === 'aggregate');
    expect(aggCall).toBeDefined();
    expect(aggCall!.args[0]).toEqual({ n: { op: 'count' } });
    expect(aggCall!.args[1]).toEqual([{ field: 'aType', op: '==', value: 'tour' }]);
  });

  it('omits aggregate on the router when the base backend omits it', () => {
    // Mirror of the findEdgesGlobal omit test. Drivers without aggregate
    // support (e.g. an in-memory or experimental backend) should propagate
    // through the router as an undefined method, not a TypeError-throwing
    // bound function. The router's "declared capability ⇒ method exists"
    // invariant is what makes the GraphClient feature-detection guard sound.
    const base = createMockBackend('base');
    (base as { aggregate?: unknown }).aggregate = undefined;
    // Also clear the cap so the routing wrapper's gated install path sees
    // the same "no aggregate" view as the runtime feature check.
    (base as { capabilities: typeof base.capabilities }).capabilities = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.aggregate).toBeUndefined();
    expect(typeof router.aggregate).toBe('undefined');
  });

  it('omits aggregate on the router when routedCapabilities intersects query.aggregate away', () => {
    // M-C cap-gate isolation test: keep `base.aggregate` defined and the
    // base's capability set including `query.aggregate`, but pass a
    // `routedCapabilities` entry that DOES NOT include `query.aggregate`.
    // The intersection at the routing wrapper drops the cap, and the
    // gating in `RoutingStorageBackend` must therefore omit `aggregate`
    // even though the underlying base method is callable.
    //
    // Without this gate, the routing wrapper would advertise "no aggregate"
    // via its capability descriptor while still exposing a working
    // `aggregate(...)` method — violating the inverse direction of the
    // "declared capability ⇒ method exists" invariant (declared-absent
    // must imply runtime-absent for sound type-narrowing).
    const base = createMockBackend('base');
    expect(base.aggregate).toBeDefined();
    expect(base.capabilities.has('query.aggregate')).toBe(true);

    const routedNoAggregate = createCapabilities(
      // Mixed-backend scenario: a routed peer that lacks aggregate support.
      // `routedCapabilities` is the caller's hand-declared cap set for the
      // routed peer; we intentionally omit `query.aggregate`.
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedNoAggregate],
    });

    expect(router.capabilities.has('query.aggregate')).toBe(false);
    expect(router.aggregate).toBeUndefined();
  });

  it('delegates bulkDelete to the base backend when the base declares query.dml', async () => {
    // Phase 5 DML pass-through: identical contract shape to the
    // aggregate/findEdgesGlobal install pair. The base backend ships
    // `bulkDelete` and `query.dml`; the router must surface a callable
    // method that forwards arguments unchanged.
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.bulkDelete).toBe('function');
    const filters: QueryFilter[] = [{ field: 'aType', op: '==', value: 'tour' }];
    const out = await router.bulkDelete!(filters, { batchSize: 50 });
    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
    const dmlCall = base.calls.find((c) => c.method === 'bulkDelete');
    expect(dmlCall).toBeDefined();
    expect(dmlCall!.args[0]).toEqual(filters);
    expect(dmlCall!.args[1]).toEqual({ batchSize: 50 });
  });

  it('delegates bulkUpdate to the base backend when the base declares query.dml', async () => {
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.bulkUpdate).toBe('function');
    const filters: QueryFilter[] = [{ field: 'aType', op: '==', value: 'tour' }];
    const patch: BulkUpdatePatch = { data: { status: 'archived' } };
    const out = await router.bulkUpdate!(filters, patch);
    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
    const dmlCall = base.calls.find((c) => c.method === 'bulkUpdate');
    expect(dmlCall).toBeDefined();
    expect(dmlCall!.args[0]).toEqual(filters);
    expect(dmlCall!.args[1]).toEqual(patch);
  });

  it('omits bulkDelete/bulkUpdate on the router when the base backend omits them', () => {
    // Drivers without DML support (Firestore Standard, the upcoming
    // pre-pipeline-DML branch) propagate through the router as undefined
    // methods. The "declared capability ⇒ method exists" invariant is
    // what makes the GraphClient feature-detection guard sound.
    const base = createMockBackend('base');
    (base as { bulkDelete?: unknown }).bulkDelete = undefined;
    (base as { bulkUpdate?: unknown }).bulkUpdate = undefined;
    (base as { capabilities: typeof base.capabilities }).capabilities = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.bulkDelete).toBeUndefined();
    expect(router.bulkUpdate).toBeUndefined();
  });

  it('omits bulkDelete/bulkUpdate on the router when routedCapabilities intersects query.dml away', () => {
    // Cap-gate isolation test (mirror of the aggregate cap-gate test). A
    // routed peer that lacks DML support drops `query.dml` from the
    // intersection, so the router must omit the methods even though the
    // underlying base methods are callable. Otherwise the routing wrapper
    // would advertise "no DML" via its capability descriptor while still
    // exposing working `bulkDelete`/`bulkUpdate` methods — violating the
    // inverse direction of "declared capability ⇒ method exists".
    const base = createMockBackend('base');
    expect(base.bulkDelete).toBeDefined();
    expect(base.bulkUpdate).toBeDefined();
    expect(base.capabilities.has('query.dml')).toBe(true);

    const routedNoDml = createCapabilities(
      // Mixed-backend scenario: a routed peer (e.g. Firestore Standard)
      // that lacks DML support. The intersection drops `query.dml`.
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedNoDml],
    });

    expect(router.capabilities.has('query.dml')).toBe(false);
    expect(router.bulkDelete).toBeUndefined();
    expect(router.bulkUpdate).toBeUndefined();
  });

  it('delegates expand to the base backend when the base declares query.join', async () => {
    // Phase 6 query.join pass-through: same install/omit pair as
    // aggregate/DML. The base ships `expand(...)` and declares
    // `query.join`; the router must surface a callable `expand` and
    // forward the params object verbatim. Same "declared cap ⇒ method
    // exists" invariant as the other capability-gated methods.
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.expand).toBe('function');
    const out = await router.expand!({
      sources: ['a', 'b'],
      axbType: 'wrote',
    });
    expect(out).toEqual({ edges: [] });
    const expandCall = base.calls.find((c) => c.method === 'expand');
    expect(expandCall).toBeDefined();
    expect(expandCall!.args[0]).toEqual({ sources: ['a', 'b'], axbType: 'wrote' });
  });

  it('omits expand on the router when the base backend omits it', () => {
    // Drivers without query.join (Firestore today) propagate through the
    // router as an undefined method. Required for the GraphClient
    // feature-detection guard to be sound — `typeof backend.expand` is the
    // documented contract. Without this gate, type-narrowing on
    // `capabilities.has('query.join')` would lie to consumers.
    const base = createMockBackend('base');
    (base as { expand?: unknown }).expand = undefined;
    (base as { capabilities: typeof base.capabilities }).capabilities = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.expand).toBeUndefined();
    expect(typeof router.expand).toBe('undefined');
  });

  it('omits expand on the router when routedCapabilities intersects query.join away', () => {
    // Cap-gate isolation test (mirror of aggregate/DML). A routed peer
    // that lacks query.join drops the cap from the intersection, so the
    // router must omit `expand` even though the underlying base method is
    // callable. Otherwise the wrapper would advertise "no query.join" via
    // its capability descriptor while still exposing a working `expand`,
    // violating the inverse "declared-absent ⇒ runtime-absent" direction.
    const base = createMockBackend('base');
    expect(base.expand).toBeDefined();
    expect(base.capabilities.has('query.join')).toBe(true);

    const routedNoJoin = createCapabilities(
      // Mixed-backend scenario: a routed peer (e.g. a Firestore-backed
      // shard) that lacks query.join. The intersection drops the cap.
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedNoJoin],
    });

    expect(router.capabilities.has('query.join')).toBe(false);
    expect(router.expand).toBeUndefined();
  });

  it('delegates findEdgesProjected to the base backend when the base declares query.select', async () => {
    // Phase 7 query.select pass-through: identical install/omit pair to
    // aggregate/DML/expand. The base ships `findEdgesProjected(...)` and
    // declares `query.select`; the router must surface a callable method
    // that forwards `(select, filters, options)` unchanged. The "declared
    // capability ⇒ method exists" invariant is what makes the GraphClient
    // feature-detection guard sound.
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.findEdgesProjected).toBe('function');
    const filters: QueryFilter[] = [{ field: 'aType', op: '==', value: 'tour' }];
    const out = await router.findEdgesProjected!(['title', 'date'], filters, { limit: 5 });
    expect(out).toEqual([]);
    const projCall = base.calls.find((c) => c.method === 'findEdgesProjected');
    expect(projCall).toBeDefined();
    expect(projCall!.args[0]).toEqual(['title', 'date']);
    expect(projCall!.args[1]).toEqual(filters);
    expect(projCall!.args[2]).toEqual({ limit: 5 });
  });

  it('omits findEdgesProjected on the router when the base backend omits it', () => {
    // Drivers without query.select (Firestore today, before Phase 7 wiring)
    // propagate through the router as an undefined method. The
    // `typeof router.findEdgesProjected` feature check is the documented
    // contract; without this gate, type-narrowing on
    // `capabilities.has('query.select')` would lie to consumers.
    const base = createMockBackend('base');
    (base as { findEdgesProjected?: unknown }).findEdgesProjected = undefined;
    (base as { capabilities: typeof base.capabilities }).capabilities = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.findEdgesProjected).toBeUndefined();
    expect(typeof router.findEdgesProjected).toBe('undefined');
  });

  it('omits findEdgesProjected on the router when routedCapabilities intersects query.select away', () => {
    // Cap-gate isolation test (mirror of aggregate/DML/expand). A routed
    // peer that lacks query.select drops the cap from the intersection, so
    // the router must omit `findEdgesProjected` even though the underlying
    // base method is callable. Otherwise the wrapper would advertise "no
    // query.select" via its capability descriptor while still exposing a
    // working `findEdgesProjected`, violating the inverse "declared-absent
    // ⇒ runtime-absent" direction of the cap-method invariant.
    const base = createMockBackend('base');
    expect(base.findEdgesProjected).toBeDefined();
    expect(base.capabilities.has('query.select')).toBe(true);

    const routedNoSelect = createCapabilities(
      // Mixed-backend scenario: a routed peer (e.g. a Firestore-backed
      // shard before Phase 7 lands there) that lacks query.select. The
      // intersection drops the cap.
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedNoSelect],
    });

    expect(router.capabilities.has('query.select')).toBe(false);
    expect(router.findEdgesProjected).toBeUndefined();
  });

  it('delegates findNearest to the base backend when the base declares search.vector', async () => {
    // Phase 8 search.vector pass-through: identical install/omit pair to
    // every other capability-gated method (aggregate / DML / expand /
    // findEdgesProjected). The base ships `findNearest(...)` and declares
    // `search.vector`; the router must surface a callable method that
    // forwards `params` unchanged. The "declared capability ⇒ method
    // exists" invariant is what makes the GraphClient feature-detection
    // guard sound, so we pin both directions explicitly.
    const base = createMockBackend('base');
    const router = createRoutingBackend(base, { route: () => null });

    expect(typeof router.findNearest).toBe('function');
    const params: FindNearestParams = {
      aType: 'doc',
      vectorField: 'embedding',
      queryVector: [0.1, 0.2, 0.3],
      limit: 5,
      distanceMeasure: 'COSINE',
    };
    const out = await router.findNearest!(params);
    expect(out).toEqual([]);
    const nearestCall = base.calls.find((c) => c.method === 'findNearest');
    expect(nearestCall).toBeDefined();
    expect(nearestCall!.args[0]).toEqual(params);
  });

  it('omits findNearest on the router when the base backend omits it', () => {
    // SQLite-shaped backends (shared SQLite, Cloudflare DO) don't ship a
    // native vector index, so they don't declare `search.vector` and don't
    // implement `findNearest`. The router must propagate the absence as an
    // undefined method — the `typeof router.findNearest` feature check is
    // the documented contract; without this gate, type-narrowing on
    // `capabilities.has('search.vector')` would lie to consumers.
    const base = createMockBackend('base');
    (base as { findNearest?: unknown }).findNearest = undefined;
    (base as { capabilities: typeof base.capabilities }).capabilities = createCapabilities(
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, { route: () => null });

    expect(router.findNearest).toBeUndefined();
    expect(typeof router.findNearest).toBe('undefined');
  });

  it('omits findNearest on the router when routedCapabilities intersects search.vector away', () => {
    // Cap-gate isolation test (mirror of every other capability-gated
    // method). A routed peer that lacks `search.vector` (e.g. a routed
    // Cloudflare-DO peer alongside a Firestore base) drops the cap from
    // the intersection, so the router must omit `findNearest` even though
    // the underlying base method is callable. Otherwise the wrapper would
    // advertise "no search.vector" via its capability descriptor while
    // still exposing a working `findNearest`, violating the inverse
    // "declared-absent ⇒ runtime-absent" direction of the cap-method
    // invariant.
    const base = createMockBackend('base');
    expect(base.findNearest).toBeDefined();
    expect(base.capabilities.has('search.vector')).toBe(true);

    const routedNoVector = createCapabilities(
      // Mixed-backend scenario: a routed peer (e.g. a Cloudflare DO shard
      // alongside a Firestore base) that lacks `search.vector`. The
      // intersection drops the cap.
      new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
    );
    const router = createRoutingBackend(base, {
      route: () => null,
      routedCapabilities: [routedNoVector],
    });

    expect(router.capabilities.has('search.vector')).toBe(false);
    expect(router.findNearest).toBeUndefined();
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
