/**
 * `DORPCBackend` + `createDOClient` unit tests.
 *
 * The client-side backend calls through a `FiregraphStub` — the RPC surface
 * of a DO. We mock that surface with in-memory bookkeeping to verify:
 *   - Method calls are routed to the right DO (stub identity == DO identity)
 *   - `.subgraph()` derives a new DO key per chain segment
 *   - Transactions throw UNSUPPORTED_OPERATION and `findEdgesGlobal` is left
 *     undefined so the client raises the generic not-supported error early
 *   - `createBatch` accumulates ops and submits them in one `_fgBatch` call
 */

import { describe, expect, it } from 'vitest';

import { createGraphClientFromBackend } from '../../src/client.js';
import type {
  DurableObjectIdLike,
  FiregraphNamespace,
  FiregraphStub,
} from '../../src/cloudflare/backend.js';
import { DORPCBackend } from '../../src/cloudflare/backend.js';
import { createDOClient, createSiblingClient } from '../../src/cloudflare/client.js';
import type { BatchOp } from '../../src/cloudflare/do.js';
import type {
  BatchBackend,
  StorageBackend,
  TransactionBackend,
} from '../../src/internal/backend.js';
import { createCapabilities } from '../../src/internal/backend.js';
import { NODE_RELATION } from '../../src/internal/constants.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
import type {
  AggregateSpec,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  Capability,
  CascadeResult,
  FindEdgesParams,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Fake DO namespace — maps storage keys to in-memory stub instances.
//
// Each FakeStub records its received calls and can be asserted against.
// `namespace.get(id)` must return the same stub for the same id so the
// backend's stub-caching behavior is observable.
// ---------------------------------------------------------------------------

interface FakeStub extends FiregraphStub {
  readonly name: string;
  readonly calls: Array<{ method: keyof FiregraphStub; args: unknown[] }>;
  records: Map<string, StoredGraphRecord>;
  /** Programmable response for the next `_fgAggregate` call. */
  aggregateResponse: Record<string, number | null>;
}

function makeStub(name: string): FakeStub {
  const calls: Array<{ method: keyof FiregraphStub; args: unknown[] }> = [];
  const records = new Map<string, StoredGraphRecord>();
  const stub: FakeStub = {
    name,
    calls,
    records,
    aggregateResponse: {},
    async _fgGetDoc(docId: string) {
      calls.push({ method: '_fgGetDoc', args: [docId] });
      return records.get(docId) ?? null;
    },
    async _fgQuery(filters: QueryFilter[], options?: QueryOptions) {
      calls.push({ method: '_fgQuery', args: [filters, options] });
      return Array.from(records.values());
    },
    async _fgAggregate(spec: AggregateSpec, filters: QueryFilter[]) {
      calls.push({ method: '_fgAggregate', args: [spec, filters] });
      return stub.aggregateResponse;
    },
    async _fgSetDoc(docId: string, record) {
      calls.push({ method: '_fgSetDoc', args: [docId, record] });
      records.set(docId, record as unknown as StoredGraphRecord);
    },
    async _fgUpdateDoc(docId: string, update) {
      calls.push({ method: '_fgUpdateDoc', args: [docId, update] });
    },
    async _fgDeleteDoc(docId: string) {
      calls.push({ method: '_fgDeleteDoc', args: [docId] });
      records.delete(docId);
    },
    async _fgBatch(ops: BatchOp[]) {
      calls.push({ method: '_fgBatch', args: [ops] });
    },
    async _fgRemoveNodeCascade(uid: string): Promise<CascadeResult> {
      calls.push({ method: '_fgRemoveNodeCascade', args: [uid] });
      return { deleted: 1, batches: 1, errors: [], edgesDeleted: 0, nodeDeleted: true };
    },
    async _fgBulkRemoveEdges(params: FindEdgesParams): Promise<BulkResult> {
      calls.push({ method: '_fgBulkRemoveEdges', args: [params] });
      return { deleted: 0, batches: 0, errors: [] };
    },
    async _fgBulkDelete(filters: QueryFilter[], options?: BulkOptions): Promise<BulkResult> {
      calls.push({ method: '_fgBulkDelete', args: [filters, options] });
      return { deleted: 0, batches: 1, errors: [] };
    },
    async _fgBulkUpdate(
      filters: QueryFilter[],
      patch: BulkUpdatePatch,
      options?: BulkOptions,
    ): Promise<BulkResult> {
      calls.push({ method: '_fgBulkUpdate', args: [filters, patch, options] });
      return { deleted: 0, batches: 1, errors: [] };
    },
    async _fgDestroy() {
      calls.push({ method: '_fgDestroy', args: [] });
    },
  };
  return stub;
}

interface FakeId extends DurableObjectIdLike {
  readonly name: string;
}

function makeNamespace(): { ns: FiregraphNamespace; stubs: Map<string, FakeStub> } {
  const stubs = new Map<string, FakeStub>();
  const ns: FiregraphNamespace = {
    idFromName(name: string): FakeId {
      return {
        name,
        toString() {
          return name;
        },
      };
    },
    get(id: DurableObjectIdLike): FiregraphStub {
      const name = (id as FakeId).name;
      let stub = stubs.get(name);
      if (!stub) {
        stub = makeStub(name);
        stubs.set(name, stub);
      }
      return stub;
    },
  };
  return { ns, stubs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DORPCBackend — identity + routing', () => {
  it('caches the stub for the configured storage key', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });

    await backend.getDoc('x:y:z');
    await backend.getDoc('x:y:z');

    // idFromName was hit once; the stub is cached for further calls.
    expect(stubs.size).toBe(1);
    expect(stubs.get('main')!.calls.filter((c) => c.method === '_fgGetDoc')).toHaveLength(2);
  });

  it('exposes storageKey and scopePath', () => {
    const backend = new DORPCBackend(makeNamespace().ns, {
      storageKey: 'main',
      scopePath: 'memories',
    });
    expect(backend.scopePath).toBe('memories');
    expect(backend.storageKey).toBe('main');
  });

  it('hardcodes collectionPath to "firegraph" and defaults scopePath to ""', () => {
    const backend = new DORPCBackend(makeNamespace().ns, { storageKey: 'main' });
    // `collectionPath` is a fixed label on the DO backend — there's no
    // user-facing knob to change it. The DO owns its SQLite table name
    // independently; see `FiregraphDOOptions.table`.
    expect(backend.collectionPath).toBe('firegraph');
    expect(backend.scopePath).toBe('');
  });
});

describe('DORPCBackend — reads/writes forward to the stub', () => {
  it('forwards getDoc / setDoc / updateDoc / deleteDoc / query', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const stub = ns.get(ns.idFromName('main')) as FakeStub;

    await backend.setDoc(
      'k1',
      {
        aType: 'a',
        aUid: 'x',
        axbType: NODE_RELATION,
        bType: 'a',
        bUid: 'x',
        data: {},
      },
      'replace',
    );
    await backend.getDoc('k1');
    await backend.updateDoc('k1', { dataOps: flattenPatch({ n: 1 }) });
    await backend.query([{ field: 'aType', op: '==', value: 'a' }]);
    await backend.deleteDoc('k1');

    const methods = stub.calls.map((c) => c.method);
    expect(methods).toEqual(['_fgSetDoc', '_fgGetDoc', '_fgUpdateDoc', '_fgQuery', '_fgDeleteDoc']);
    expect(stubs.size).toBe(1);
  });
});

describe('DORPCBackend.aggregate — wire null → 0/NaN translation', () => {
  // The DO returns `Record<string, number | null>` so the empty-set null
  // distinction survives the structured-clone RPC boundary. The client-side
  // backend is responsible for resolving null → 0 (SUM/MIN/MAX) or NaN (AVG)
  // so the cross-backend contract stays `Record<string, number>`.

  it('forwards spec + filters to _fgAggregate and unwraps numeric results', async () => {
    const { ns } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const stub = ns.get(ns.idFromName('main')) as FakeStub;
    stub.aggregateResponse = { n: 4, s: 100, a: 25 };

    const out = await backend.aggregate!(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    expect(out).toEqual({ n: 4, s: 100, a: 25 });

    const aggCall = stub.calls.find((c) => c.method === '_fgAggregate');
    expect(aggCall).toBeTruthy();
    expect(aggCall!.args[1]).toEqual([{ field: 'aType', op: '==', value: 'tour' }]);
  });

  it('resolves null → 0 for sum/min/max and NaN for avg', async () => {
    const { ns } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const stub = ns.get(ns.idFromName('main')) as FakeStub;
    // Empty filter set on the DO side returns null for every non-count op.
    stub.aggregateResponse = { n: 0, s: null, a: null, lo: null, hi: null };

    const out = await backend.aggregate!(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [],
    );
    expect(out.n).toBe(0);
    expect(out.s).toBe(0);
    expect(Number.isNaN(out.a)).toBe(true);
    expect(out.lo).toBe(0);
    expect(out.hi).toBe(0);
  });

  it('throws UNSUPPORTED_OPERATION when the wrapped stub omits _fgAggregate', async () => {
    // `_fgAggregate` is optional on `FiregraphStub` so external worker code
    // that hand-rolls a thin RPC wrapper around a DO can still compile (this
    // is the C2 fix from the first audit pass — see backend.ts:316). The
    // backend must surface a clean `UNSUPPORTED_OPERATION` here rather than
    // letting the call land as `TypeError: stub._fgAggregate is not a
    // function`. We simulate the lean-stub case by deleting the method on a
    // FakeStub *before* dispatching through the backend, then asserting the
    // typed firegraph error code.
    const stubs = new Map<string, FakeStub>();
    const ns: FiregraphNamespace = {
      idFromName(name: string): FakeId {
        return {
          name,
          toString() {
            return name;
          },
        };
      },
      get(id: DurableObjectIdLike) {
        const name = (id as FakeId).name;
        let stub = stubs.get(name);
        if (!stub) {
          stub = makeStub(name);
          // Strip _fgAggregate to model an external wrapper that never
          // forwarded the optional method.
          (stub as unknown as { _fgAggregate?: unknown })._fgAggregate = undefined;
          stubs.set(name, stub);
        }
        return stub;
      },
    };
    const backend = new DORPCBackend(ns, { storageKey: 'main' });

    await expect(backend.aggregate!({ n: { op: 'count' } }, [])).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('_fgAggregate'),
    });

    // No call should reach the stub; the surface check happens before
    // anything is dispatched.
    const stub = stubs.get('main')!;
    expect(stub.calls.find((c) => c.method === '_fgAggregate')).toBeUndefined();
  });
});

describe('DORPCBackend — subgraph routing', () => {
  it('derives a new DO key from the parent chain (${key}/${uid}/${name})', () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const child = backend.subgraph('projA', 'memories') as DORPCBackend;

    expect(child.storageKey).toBe('main/projA/memories');
    expect(child.scopePath).toBe('memories');

    const grandchild = child.subgraph('projB', 'context') as DORPCBackend;
    expect(grandchild.storageKey).toBe('main/projA/memories/projB/context');
    expect(grandchild.scopePath).toBe('memories/context');

    // Each distinct key hits a distinct stub.
    void stubs; // cached lazily on first call — no assertion needed here.
  });

  it('isolates writes per subgraph DO (different storage key ⇒ different stub)', async () => {
    const { ns, stubs } = makeNamespace();
    const root = new DORPCBackend(ns, { storageKey: 'main' });
    const child = root.subgraph('projA', 'memories');

    await root.setDoc(
      'k1',
      {
        aType: 'a',
        aUid: 'x',
        axbType: NODE_RELATION,
        bType: 'a',
        bUid: 'x',
        data: {},
      },
      'replace',
    );
    await child.setDoc(
      'k2',
      {
        aType: 'a',
        aUid: 'y',
        axbType: NODE_RELATION,
        bType: 'a',
        bUid: 'y',
        data: {},
      },
      'replace',
    );

    expect(stubs.size).toBe(2);
    expect(stubs.get('main')!.records.has('k1')).toBe(true);
    expect(stubs.get('main')!.records.has('k2')).toBe(false);
    expect(stubs.get('main/projA/memories')!.records.has('k2')).toBe(true);
  });

  it('rejects invalid parentNodeUid or subgraph name', () => {
    const backend = new DORPCBackend(makeNamespace().ns, { storageKey: 'main' });
    expect(() => backend.subgraph('', 'name')).toThrow(/Invalid parentNodeUid/);
    expect(() => backend.subgraph('a/b', 'name')).toThrow(/Invalid parentNodeUid/);
    expect(() => backend.subgraph('uid', '')).toThrow(/Invalid subgraph name/);
    expect(() => backend.subgraph('uid', 'a/b')).toThrow(/Invalid subgraph name/);
  });
});

describe('DORPCBackend — unsupported paths', () => {
  it('runTransaction throws UNSUPPORTED_OPERATION without running the callback', async () => {
    const backend = new DORPCBackend(makeNamespace().ns, { storageKey: 'main' });
    let ran = false;
    await expect(
      backend.runTransaction(async () => {
        ran = true;
        return 'x';
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    expect(ran).toBe(false);
  });

  it('leaves findEdgesGlobal undefined so the client emits UNSUPPORTED_OPERATION early', async () => {
    // Leaving the method undefined is deliberate. The GraphClient checks
    // for presence before running query planning and throws immediately when
    // absent — the caller gets an accurate error without first hitting the
    // misleading `QuerySafetyError` that a defined-but-throwing method
    // would produce for scan-unsafe calls. The user-facing rationale lives
    // in `createDOClient`'s "What's not supported" docstring section.
    const backend = new DORPCBackend(makeNamespace().ns, { storageKey: 'main' });
    expect(backend.findEdgesGlobal).toBeUndefined();

    // End-to-end: the client surfaces UNSUPPORTED_OPERATION through the
    // missing-method branch of `GraphClientImpl.findEdgesGlobal`.
    const client = createDOClient(makeNamespace().ns, 'main');
    await expect(client.findEdgesGlobal({ aType: 'tour' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });
});

describe('DORPCBackend — batches', () => {
  it('buffers ops and submits them in one _fgBatch call', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const batch = backend.createBatch();

    batch.setDoc(
      'k1',
      {
        aType: 'a',
        aUid: 'x',
        axbType: NODE_RELATION,
        bType: 'a',
        bUid: 'x',
        data: {},
      },
      'replace',
    );
    batch.updateDoc('k2', { dataOps: flattenPatch({ n: 1 }) });
    batch.deleteDoc('k3');
    await batch.commit();

    const stub = stubs.get('main')!;
    const batchCalls = stub.calls.filter((c) => c.method === '_fgBatch');
    expect(batchCalls).toHaveLength(1);
    const ops = batchCalls[0].args[0] as BatchOp[];
    expect(ops.map((o) => o.kind)).toEqual(['set', 'update', 'delete']);
  });

  it('is a no-op on empty commit', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const batch = backend.createBatch();
    await batch.commit();
    // Empty commit doesn't instantiate the stub — no RPC made.
    expect(stubs.size).toBe(0);
  });

  it('clears the buffer so a second commit is also a no-op', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const batch = backend.createBatch();
    batch.deleteDoc('k1');
    await batch.commit();
    await batch.commit();

    const stub = stubs.get('main')!;
    expect(stub.calls.filter((c) => c.method === '_fgBatch')).toHaveLength(1);
  });
});

describe('DORPCBackend — cascade + bulk + destroy', () => {
  it('forwards removeNodeCascade to _fgRemoveNodeCascade', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });

    // Registry-less backends don't consult the reader during cascade — they
    // forward directly to the DO — so a minimal stub is enough.
    const reader = {} as Parameters<typeof backend.removeNodeCascade>[1];
    const res = await backend.removeNodeCascade('uid123', reader);

    expect(res.nodeDeleted).toBe(true);
    expect(stubs.get('main')!.calls.at(-1)!.method).toBe('_fgRemoveNodeCascade');
  });

  it('forwards bulkRemoveEdges to _fgBulkRemoveEdges', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const reader = {} as Parameters<typeof backend.bulkRemoveEdges>[1];
    await backend.bulkRemoveEdges({ aUid: 'x', axbType: 'y' }, reader);

    expect(stubs.get('main')!.calls.at(-1)!.method).toBe('_fgBulkRemoveEdges');
  });

  it('forwards bulkDelete to _fgBulkDelete with filters and options', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const filters: QueryFilter[] = [{ field: 'aType', op: '==', value: 'tour' }];
    const out = await backend.bulkDelete!(filters, { batchSize: 50 });

    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
    const dmlCall = stubs.get('main')!.calls.find((c) => c.method === '_fgBulkDelete');
    expect(dmlCall).toBeTruthy();
    expect(dmlCall!.args[0]).toEqual(filters);
    expect(dmlCall!.args[1]).toEqual({ batchSize: 50 });
  });

  it('forwards bulkUpdate to _fgBulkUpdate with filters, patch, and options', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    const filters: QueryFilter[] = [{ field: 'aType', op: '==', value: 'tour' }];
    const patch: BulkUpdatePatch = { data: { status: 'archived' } };
    const out = await backend.bulkUpdate!(filters, patch);

    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
    const dmlCall = stubs.get('main')!.calls.find((c) => c.method === '_fgBulkUpdate');
    expect(dmlCall).toBeTruthy();
    expect(dmlCall!.args[0]).toEqual(filters);
    expect(dmlCall!.args[1]).toEqual(patch);
  });

  it('throws UNSUPPORTED_OPERATION when the wrapped stub omits _fgBulkDelete / _fgBulkUpdate', async () => {
    // Both DML methods are optional on `FiregraphStub` so external worker code
    // that hand-rolls a thin RPC wrapper around a DO can still compile (same
    // pattern as `_fgAggregate`). The backend must surface a clean
    // `UNSUPPORTED_OPERATION` rather than landing as a runtime TypeError.
    const stubs = new Map<string, FakeStub>();
    const ns: FiregraphNamespace = {
      idFromName(name: string): FakeId {
        return { name, toString: () => name };
      },
      get(id: DurableObjectIdLike) {
        const name = (id as FakeId).name;
        let stub = stubs.get(name);
        if (!stub) {
          stub = makeStub(name);
          (stub as unknown as { _fgBulkDelete?: unknown })._fgBulkDelete = undefined;
          (stub as unknown as { _fgBulkUpdate?: unknown })._fgBulkUpdate = undefined;
          stubs.set(name, stub);
        }
        return stub;
      },
    };
    const backend = new DORPCBackend(ns, { storageKey: 'main' });

    await expect(backend.bulkDelete!([], {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('_fgBulkDelete'),
    });
    await expect(backend.bulkUpdate!([], { data: { x: 1 } }, {})).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: expect.stringContaining('_fgBulkUpdate'),
    });
  });

  it('destroy() forwards to _fgDestroy (cross-DO cascade hook)', async () => {
    const { ns, stubs } = makeNamespace();
    const backend = new DORPCBackend(ns, { storageKey: 'main' });
    await backend.destroy();
    expect(stubs.get('main')!.calls.at(-1)!.method).toBe('_fgDestroy');
  });
});

// ---------------------------------------------------------------------------
// createDOClient
// ---------------------------------------------------------------------------

describe('createDOClient', () => {
  it('returns a usable GraphClient backed by the namespace', async () => {
    const { ns, stubs } = makeNamespace();
    const client = createDOClient(ns, 'main');
    // Delegating a read through the client's backend confirms the wire-up.
    void client;
    // Trigger a call through the client's `edgeExists` path would require a
    // full GraphClient instantiation; `createDOClient` is exercised enough
    // by confirming it didn't throw and the DO namespace still has no
    // cached stub (lazy until first call).
    expect(stubs.size).toBe(0);
  });

  it('throws on empty rootKey', () => {
    expect(() => createDOClient(makeNamespace().ns, '')).toThrow(
      /rootKey must be a non-empty string/,
    );
  });

  it('throws when rootKey contains "/"', () => {
    expect(() => createDOClient(makeNamespace().ns, 'a/b')).toThrow(
      /rootKey must not contain "\/"/,
    );
  });

  it('returns a DynamicGraphClient when registryMode is provided', () => {
    const client = createDOClient(makeNamespace().ns, 'main', {
      registryMode: { mode: 'dynamic' },
    });
    // Narrowed overload: dynamic mode exposes `defineNodeType` / `defineEdgeType` /
    // `reloadRegistry`. Non-null sanity checks are enough — full dynamic behavior
    // is exercised end-to-end in the e2e suite.
    expect(typeof client.defineNodeType).toBe('function');
    expect(typeof client.defineEdgeType).toBe('function');
    expect(typeof client.reloadRegistry).toBe('function');
  });

  it('rejects registryMode.collection with a slash', () => {
    expect(() =>
      createDOClient(makeNamespace().ns, 'main', {
        registryMode: { mode: 'dynamic', collection: 'bad/key' },
      }),
    ).toThrow(/registryMode\.collection must not contain "\/"/);
  });
});

// ---------------------------------------------------------------------------
// createSiblingClient
// ---------------------------------------------------------------------------

describe('createSiblingClient', () => {
  it('returns a peer client that addresses a different root DO', async () => {
    const { ns, stubs } = makeNamespace();
    const root = createDOClient(ns, 'tenant-a');
    const sibling = createSiblingClient(root, 'tenant-b');

    // Each client's first write should hit its own DO stub — same namespace,
    // different keys. This is what `createSiblingClient` is supposed to
    // achieve: ergonomic peer access without re-plumbing options.
    await root.putNode('tour', 'node-a', {});
    await sibling.putNode('tour', 'node-b', {});

    expect(stubs.has('tenant-a')).toBe(true);
    expect(stubs.has('tenant-b')).toBe(true);
    expect(stubs.get('tenant-a')!.records.size).toBe(1);
    expect(stubs.get('tenant-b')!.records.size).toBe(1);
  });

  it('works when the source client is a subgraph of the original root', async () => {
    const { ns, stubs } = makeNamespace();
    const root = createDOClient(ns, 'tenant-a');
    const subgraph = root.subgraph('parent', 'memories');
    const sibling = createSiblingClient(subgraph, 'tenant-b');

    // Sibling should point at root `tenant-b`, not at a subgraph of
    // `tenant-a`. Verified by watching which DO stub the write lands on.
    await sibling.putNode('tour', 'node-b', {});
    expect(stubs.has('tenant-b')).toBe(true);
    expect(stubs.has('tenant-a/parent/memories')).toBe(false);
  });

  it('throws on empty siblingRootKey', () => {
    const root = createDOClient(makeNamespace().ns, 'tenant-a');
    expect(() => createSiblingClient(root, '')).toThrow(
      /siblingRootKey must be a non-empty string/,
    );
  });

  it('throws when siblingRootKey contains "/"', () => {
    const root = createDOClient(makeNamespace().ns, 'tenant-a');
    expect(() => createSiblingClient(root, 'a/b')).toThrow(/siblingRootKey must not contain "\/"/);
  });

  it('throws UNSUPPORTED_OPERATION when the client is not DO-backed', () => {
    // Hand-build a DORPCBackend WITHOUT the sibling-factory wiring, so
    // `createSiblingClient` has no way to construct a peer. This simulates
    // callers who bypass `createDOClient` and instantiate the backend
    // directly — the helper should refuse rather than silently construct a
    // broken sibling.
    const { ns } = makeNamespace();
    const bareBackend = new DORPCBackend(ns, { storageKey: 'bare' });
    const bareClient = createGraphClientFromBackend(bareBackend);

    expect(() => createSiblingClient(bareClient, 'tenant-b')).toThrow(
      /not backed by a DO client produced by `createDOClient`/,
    );
    expect(() => createSiblingClient(bareClient, 'tenant-b')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
    );
  });

  it('throws UNSUPPORTED_OPERATION when the backend is a different storage class (e.g. Firestore-like)', () => {
    // The more common misuse: passing a client backed by Firestore,
    // SQLite, or any other non-DO storage into `createSiblingClient`. The
    // previous test exercises a bare `DORPCBackend`; this one exercises
    // the path where the backend isn't a `DORPCBackend` at all — the
    // duck-typed `typeof maker === 'function'` check has to reject both
    // shapes identically, which `instanceof DORPCBackend` would not (it
    // would still reject, but for the wrong reason, and would be fragile
    // across module boundaries in monorepos with duplicated copies).
    const noop = async (): Promise<void> => {};
    const fakeBackend: StorageBackend = {
      capabilities: createCapabilities(
        new Set<Capability>(['core.read', 'core.write', 'core.batch', 'core.subgraph']),
      ),
      collectionPath: 'firestore-graphs',
      scopePath: '',
      async getDoc() {
        return null;
      },
      async query() {
        return [];
      },
      setDoc: noop,
      updateDoc: noop,
      deleteDoc: noop,
      async runTransaction<T>(_fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
        throw new Error('runTransaction unused in stub');
      },
      createBatch(): BatchBackend {
        return {
          setDoc() {},
          updateDoc() {},
          deleteDoc() {},
          async commit() {},
        };
      },
      subgraph() {
        return fakeBackend;
      },
      async removeNodeCascade() {
        return {
          deleted: 0,
          batches: 0,
          errors: [],
          edgesDeleted: 0,
          nodeDeleted: false,
        };
      },
      async bulkRemoveEdges() {
        return { deleted: 0, batches: 0, errors: [] };
      },
    };
    const foreignClient = createGraphClientFromBackend(fakeBackend);

    expect(() => createSiblingClient(foreignClient, 'tenant-b')).toThrow(
      /not backed by a DO client produced by `createDOClient`/,
    );
    expect(() => createSiblingClient(foreignClient, 'tenant-b')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
    );
  });

  it('inherits registry/options from the original createDOClient call', async () => {
    const { ns } = makeNamespace();
    // Dynamic mode exposes `defineNodeType`, so checking that the sibling
    // is dynamic proves the options propagated (the only way a sibling
    // would have a `defineNodeType` is if `registryMode` carried across).
    const root = createDOClient(ns, 'tenant-a', { registryMode: { mode: 'dynamic' } });
    const sibling = createSiblingClient(root, 'tenant-b');
    expect(typeof sibling.defineNodeType).toBe('function');
    expect(typeof sibling.defineEdgeType).toBe('function');
    expect(typeof sibling.reloadRegistry).toBe('function');
  });
});
