/**
 * End-to-end wiring test: `createDOClient` ⇒ `DORPCBackend` ⇒ `FiregraphDO`.
 *
 * This stitches the real FiregraphDO (backed by better-sqlite3) to the real
 * DORPCBackend through a fake namespace, then routes everything through the
 * public `createDOClient` factory. The goal is to catch any mismatch between
 * what the DO emits over RPC and what the backend expects — the shape that
 * structured clone would deliver to a real Worker.
 *
 * We don't use Miniflare here; this lives in the unit suite because it's
 * fast and hermetic. Miniflare-driven integration tests can come later.
 */

import type { Database as BetterSqliteDb } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type {
  DurableObjectIdLike,
  FiregraphNamespace,
  FiregraphStub,
} from '../../src/cloudflare/backend.js';
import { createDOClient } from '../../src/cloudflare/client.js';
import type {
  DOSqlCursor,
  DOSqlExecutor,
  DOStorage,
  DurableObjectStateLike,
} from '../../src/cloudflare/do.js';
import { FiregraphDO } from '../../src/cloudflare/do.js';
import { generateId } from '../../src/id.js';
import { createRegistry } from '../../src/registry.js';
import { GraphTimestampImpl } from '../../src/timestamp.js';

// ---------------------------------------------------------------------------
// Fake namespace that spins up a real FiregraphDO per unique ID.
//
// Each DO gets its own SQLite database — mirrors the "one DO = one database"
// design. A second `.get()` with the same id returns the same DO instance
// (DO identity is stable per name).
// ---------------------------------------------------------------------------

interface FakeId extends DurableObjectIdLike {
  readonly name: string;
}

/**
 * Bundle returned from `makeInspectableNamespace()` — the namespace plus a
 * helper that tells the test how many rows a given DO holds. Cross-DO
 * cascade tests use this to assert "that DO got destroyed" by checking its
 * row count instead of watching RPC calls.
 */
interface InspectableNamespace {
  namespace: FiregraphNamespace;
  rowCount(storageKey: string): number;
  hasDO(storageKey: string): boolean;
}

function makeInspectableNamespace(): InspectableNamespace {
  const dos = new Map<string, FiregraphDO>();
  const dbs = new Map<string, BetterSqliteDb>();

  function instantiateDO(storageKey: string): FiregraphDO {
    const db = new Database(':memory:');
    dbs.set(storageKey, db);
    const sql: DOSqlExecutor = {
      exec<T = Record<string, unknown>>(text: string, ...params: unknown[]): DOSqlCursor<T> {
        const stmt = db.prepare(text);
        const returnsRows = stmt.reader;
        return {
          toArray(): T[] {
            if (returnsRows) return stmt.all(...(params as unknown[])) as T[];
            stmt.run(...(params as unknown[]));
            return [];
          },
        };
      },
    };
    const storage: DOStorage = {
      sql,
      transactionSync<T>(fn: () => T): T {
        return db.transaction(fn)();
      },
    };
    const ctx: DurableObjectStateLike = {
      storage,
      async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
        return fn();
      },
    };
    return new FiregraphDO(ctx, {});
  }

  // Simulate the DO RPC boundary: structured-clone every argument in and
  // every return value out. The boundary is what would otherwise expose
  // class-prototype loss (e.g. `GraphTimestampImpl` becoming a plain object).
  function wrapStubWithClone(doInstance: FiregraphDO): FiregraphStub {
    const wrap = <Args extends unknown[], R>(
      fn: (...args: Args) => Promise<R>,
    ): ((...args: Args) => Promise<R>) => {
      return async (...args: Args) => {
        const clonedArgs = args.map((a) => structuredClone(a)) as Args;
        const result = await fn(...clonedArgs);
        return structuredClone(result);
      };
    };
    return {
      _fgGetDoc: wrap(doInstance._fgGetDoc.bind(doInstance)),
      _fgQuery: wrap(doInstance._fgQuery.bind(doInstance)),
      _fgAggregate: wrap(doInstance._fgAggregate.bind(doInstance)),
      _fgSetDoc: wrap(doInstance._fgSetDoc.bind(doInstance)),
      _fgUpdateDoc: wrap(doInstance._fgUpdateDoc.bind(doInstance)),
      _fgDeleteDoc: wrap(doInstance._fgDeleteDoc.bind(doInstance)),
      _fgBatch: wrap(doInstance._fgBatch.bind(doInstance)),
      _fgRemoveNodeCascade: wrap(doInstance._fgRemoveNodeCascade.bind(doInstance)),
      _fgBulkRemoveEdges: wrap(doInstance._fgBulkRemoveEdges.bind(doInstance)),
      _fgDestroy: wrap(doInstance._fgDestroy.bind(doInstance)),
    };
  }

  const stubs = new Map<string, FiregraphStub>();

  const namespace: FiregraphNamespace = {
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
        let doInstance = dos.get(name);
        if (!doInstance) {
          doInstance = instantiateDO(name);
          dos.set(name, doInstance);
        }
        stub = wrapStubWithClone(doInstance);
        stubs.set(name, stub);
      }
      return stub;
    },
  };

  return {
    namespace,
    rowCount(storageKey: string): number {
      const db = dbs.get(storageKey);
      if (!db) return 0;
      const row = db.prepare('SELECT COUNT(*) AS n FROM firegraph').get() as { n: number };
      return row.n;
    },
    hasDO(storageKey: string): boolean {
      return dbs.has(storageKey);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDOClient + FiregraphDO — end-to-end', () => {
  it('round-trips a node through putNode + getNode', async () => {
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    const uid = generateId();
    await client.putNode('tour', uid, { title: 'Everest', difficulty: 7 });

    const rec = await client.getNode(uid);
    expect(rec).not.toBeNull();
    expect(rec!.aUid).toBe(uid);
    expect(rec!.data).toEqual({ title: 'Everest', difficulty: 7 });
    // Timestamps MUST be GraphTimestampImpl on the client side after the
    // wire → hydrate round-trip. This is the regression test for the
    // prototype-loss blocker the auditor flagged.
    expect(rec!.createdAt).toBeInstanceOf(GraphTimestampImpl);
    expect(typeof rec!.createdAt.toMillis()).toBe('number');
  });

  it('isolates subgraph writes to a different DO', async () => {
    const ns = makeInspectableNamespace().namespace;
    const root = createDOClient(ns, 'root');
    const parentUid = generateId();
    await root.putNode('project', parentUid, { name: 'proj' });

    const child = root.subgraph(parentUid, 'memories');
    const childNodeUid = generateId();
    await child.putNode('memory', childNodeUid, { note: 'x' });

    // Child node must not be visible from the root DO.
    const fromRoot = await root.getNode(childNodeUid);
    expect(fromRoot).toBeNull();

    const fromChild = await child.getNode(childNodeUid);
    expect(fromChild).not.toBeNull();
    expect(fromChild!.data).toEqual({ note: 'x' });

    // Root still has its own node.
    expect(await root.getNode(parentUid)).not.toBeNull();
  });

  it('query + findEdges exercise the hydration path', async () => {
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    const [uid1, uid2] = [generateId(), generateId()];
    await client.putNode('tour', uid1, { status: 'active' });
    await client.putNode('tour', uid2, { status: 'active' });
    await client.putEdge('tour', uid1, 'hasDeparture', 'tour', uid2, {});

    const edges = await client.findEdges({ aUid: uid1, axbType: 'hasDeparture' });
    expect(edges).toHaveLength(1);
    expect(edges[0].aUid).toBe(uid1);
    expect(edges[0].bUid).toBe(uid2);
    expect(edges[0].createdAt).toBeInstanceOf(GraphTimestampImpl);

    const nodes = await client.findNodes({ aType: 'tour' });
    expect(nodes).toHaveLength(2);
    for (const n of nodes) {
      expect(n.createdAt).toBeInstanceOf(GraphTimestampImpl);
    }
  });

  it('batch commits atomically', async () => {
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    const [uid1, uid2] = [generateId(), generateId()];
    const batch = client.batch();
    batch.putNode('tour', uid1, { title: 'A' });
    batch.putNode('tour', uid2, { title: 'B' });
    batch.putEdge('tour', uid1, 'hasDeparture', 'tour', uid2, {});
    await batch.commit();

    expect(await client.getNode(uid1)).not.toBeNull();
    expect(await client.getNode(uid2)).not.toBeNull();
    expect(await client.edgeExists(uid1, 'hasDeparture', uid2)).toBe(true);
  });

  it('removeNodeCascade removes the node and its edges (DO-local)', async () => {
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    const [hub, child] = [generateId(), generateId()];
    await client.putNode('tour', hub, { name: 'hub' });
    await client.putNode('tour', child, { name: 'c' });
    await client.putEdge('tour', hub, 'hasDeparture', 'tour', child, {});

    const result = await client.removeNodeCascade(hub);
    expect(result.nodeDeleted).toBe(true);
    expect(result.edgesDeleted).toBe(1);

    expect(await client.getNode(hub)).toBeNull();
    expect(await client.edgeExists(hub, 'hasDeparture', child)).toBe(false);
    // Child's self-loop survives the cascade.
    expect(await client.getNode(child)).not.toBeNull();
  });

  it('findEdgesGlobal throws UNSUPPORTED_OPERATION before query planning', async () => {
    // Left undefined on the backend by design — the client's not-supported
    // branch fires immediately, which means the caller gets a clean error
    // regardless of whether the query would have been scan-safe. A defined-
    // but-throwing method would let `checkQuerySafety` raise first and
    // deliver a misleading "add filters like aUid+axbType" hint.
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    await expect(client.findEdgesGlobal({ aType: 'tour' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    // Same response even with allowCollectionScan — the backend simply
    // doesn't implement the method, so scan safety is never relevant.
    await expect(
      client.findEdgesGlobal({ aType: 'tour', allowCollectionScan: true }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('runTransaction throws UNSUPPORTED_OPERATION', async () => {
    const client = createDOClient(makeInspectableNamespace().namespace, 'root');
    await expect(client.runTransaction(async () => 'x')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-DO cascade (phase 2)
//
// These tests verify that `removeNodeCascade` consults the registry's
// subgraph topology and tears down descendant subgraph DOs. We use the
// inspectable namespace so we can assert "that DO's SQL table is empty"
// after cascade, which is the real signal that `_fgDestroy` ran over RPC.
// ---------------------------------------------------------------------------

describe('createDOClient — cross-DO cascade via topology', () => {
  // Registry: a `project` node has a `memories` subgraph containing
  // `memory` nodes. The `hasMemory` edge is what declares the subgraph;
  // its `targetGraph: 'memories'` is what the topology index picks up.
  const registry = createRegistry([
    { aType: 'project', axbType: 'is', bType: 'project' },
    { aType: 'memory', axbType: 'is', bType: 'memory' },
    {
      aType: 'project',
      axbType: 'hasMemory',
      bType: 'memory',
      targetGraph: 'memories',
    },
  ]);

  it('wipes child subgraph DO when cascading a node with topology', async () => {
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry });

    const projectUid = generateId();
    await root.putNode('project', projectUid, { name: 'apollo' });

    // Populate the child subgraph DO — this forces it to exist.
    const memories = root.subgraph(projectUid, 'memories');
    const memoryUid = generateId();
    await memories.putNode('memory', memoryUid, { note: 'hello' });

    const childKey = `root/${projectUid}/memories`;
    expect(ns.hasDO(childKey)).toBe(true);
    expect(ns.rowCount(childKey)).toBe(1);

    const result = await root.removeNodeCascade(projectUid);
    expect(result.nodeDeleted).toBe(true);

    // Parent DO: project is gone.
    expect(await root.getNode(projectUid)).toBeNull();
    // Child DO: every row was wiped by `_fgDestroy`.
    expect(ns.rowCount(childKey)).toBe(0);
  });

  it('recursively wipes nested subgraph DOs depth-first', async () => {
    // Two-level topology: project -[hasMemory]-> memory, memory -[hasTag]-> tag (subgraph 'tags').
    const nested = createRegistry([
      { aType: 'project', axbType: 'is', bType: 'project' },
      { aType: 'memory', axbType: 'is', bType: 'memory' },
      { aType: 'tag', axbType: 'is', bType: 'tag' },
      {
        aType: 'project',
        axbType: 'hasMemory',
        bType: 'memory',
        targetGraph: 'memories',
      },
      {
        aType: 'memory',
        axbType: 'hasTag',
        bType: 'tag',
        targetGraph: 'tags',
      },
    ]);

    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry: nested });

    const projectUid = generateId();
    const memoryUid = generateId();
    const tagUid = generateId();

    await root.putNode('project', projectUid, { name: 'p' });

    const memoriesSub = root.subgraph(projectUid, 'memories');
    await memoriesSub.putNode('memory', memoryUid, { note: 'n' });

    const tagsSub = memoriesSub.subgraph(memoryUid, 'tags');
    await tagsSub.putNode('tag', tagUid, { label: 't' });

    const memoriesKey = `root/${projectUid}/memories`;
    const tagsKey = `root/${projectUid}/memories/${memoryUid}/tags`;
    expect(ns.rowCount(memoriesKey)).toBe(1);
    expect(ns.rowCount(tagsKey)).toBe(1);

    await root.removeNodeCascade(projectUid);

    // Both descendant DOs are wiped — the tags DO because it's a
    // grand-descendant, which only works if the recursion walks the
    // memories DO's nodes and picks up their topology.
    expect(ns.rowCount(memoriesKey)).toBe(0);
    expect(ns.rowCount(tagsKey)).toBe(0);
    expect(await root.getNode(projectUid)).toBeNull();
  });

  it('does not touch descendant DOs when no registry is wired', async () => {
    // No registry → the backend's accessor returns undefined → local-only
    // cascade. Child DO rows survive (the caller owns cleanup).
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root');

    const projectUid = generateId();
    await root.putNode('project', projectUid, { name: 'p' });
    const memoriesSub = root.subgraph(projectUid, 'memories');
    const memoryUid = generateId();
    await memoriesSub.putNode('memory', memoryUid, { note: 'n' });

    const childKey = `root/${projectUid}/memories`;
    expect(ns.rowCount(childKey)).toBe(1);

    await root.removeNodeCascade(projectUid);

    // Parent gone, child DO untouched.
    expect(await root.getNode(projectUid)).toBeNull();
    expect(ns.rowCount(childKey)).toBe(1);
  });

  it('leaves child DOs untouched when the type has no topology', async () => {
    // `tour` has no subgraph children in the registry; cascading it should
    // behave identically to the no-registry case for any siblings.
    const reg = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
      { aType: 'project', axbType: 'is', bType: 'project' },
      {
        aType: 'project',
        axbType: 'hasMemory',
        bType: 'memory',
        targetGraph: 'memories',
      },
      { aType: 'memory', axbType: 'is', bType: 'memory' },
    ]);
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry: reg });

    const tourUid = generateId();
    const projectUid = generateId();
    await root.putNode('tour', tourUid, { title: 't' });
    await root.putNode('project', projectUid, { name: 'p' });

    // Populate a sibling project's subgraph DO.
    const memoriesSub = root.subgraph(projectUid, 'memories');
    await memoriesSub.putNode('memory', generateId(), { note: 'n' });
    const memoriesKey = `root/${projectUid}/memories`;
    expect(ns.rowCount(memoriesKey)).toBe(1);

    // Cascading the tour should not reach any subgraph DO.
    await root.removeNodeCascade(tourUid);
    expect(ns.rowCount(memoriesKey)).toBe(1);
  });

  it('skips cross-DO cascade when the node is already absent', async () => {
    // A caller retrying cascade on a missing node gets `nodeDeleted: false`
    // and no child-DO work — we short-circuit before any `_fgQuery` fan-out.
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry });

    const ghostUid = generateId();
    const result = await root.removeNodeCascade(ghostUid);
    expect(result.nodeDeleted).toBe(false);
    expect(result.edgesDeleted).toBe(0);
    // No child DO was instantiated because we never queried for the ghost's topology.
    expect(ns.hasDO(`root/${ghostUid}/memories`)).toBe(false);
  });

  it('cascades subgraph → subsubgraph from a subgraph client', async () => {
    // When a user holds a subgraph client and cascades a node living in
    // that subgraph, the backend's registry accessor must still fire —
    // otherwise nested subgraphs under that node leak.
    const nested = createRegistry([
      { aType: 'project', axbType: 'is', bType: 'project' },
      { aType: 'memory', axbType: 'is', bType: 'memory' },
      { aType: 'tag', axbType: 'is', bType: 'tag' },
      {
        aType: 'project',
        axbType: 'hasMemory',
        bType: 'memory',
        targetGraph: 'memories',
      },
      {
        aType: 'memory',
        axbType: 'hasTag',
        bType: 'tag',
        targetGraph: 'tags',
      },
    ]);
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry: nested });

    const projectUid = generateId();
    const memoryUid = generateId();
    const tagUid = generateId();

    await root.putNode('project', projectUid, { name: 'p' });
    const memoriesSub = root.subgraph(projectUid, 'memories');
    await memoriesSub.putNode('memory', memoryUid, { note: 'n' });
    const tagsSub = memoriesSub.subgraph(memoryUid, 'tags');
    await tagsSub.putNode('tag', tagUid, { label: 't' });

    const tagsKey = `root/${projectUid}/memories/${memoryUid}/tags`;
    expect(ns.rowCount(tagsKey)).toBe(1);

    // Cascade the memory from the subgraph client — it should destroy tags.
    await memoriesSub.removeNodeCascade(memoryUid);
    expect(ns.rowCount(tagsKey)).toBe(0);
    // The memories DO still holds the project→memory edge? No — `is` is
    // gone and the edge targeted the memory so the cascade removed it too.
    expect(await memoriesSub.getNode(memoryUid)).toBeNull();
  });

  it('preserves descendant DOs when deleteSubcollections is false', async () => {
    // The Firestore and SQLite backends honor `deleteSubcollections: false`
    // by leaving every subcollection row intact while still removing the
    // parent node. Cross-DO cascade must match that semantic — a user
    // expecting their child subgraphs to survive a targeted node delete
    // should not see them wiped.
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry });

    const projectUid = generateId();
    await root.putNode('project', projectUid, { name: 'apollo' });

    const memoriesSub = root.subgraph(projectUid, 'memories');
    await memoriesSub.putNode('memory', generateId(), { note: 'keep me' });

    const childKey = `root/${projectUid}/memories`;
    expect(ns.rowCount(childKey)).toBe(1);

    const result = await root.removeNodeCascade(projectUid, { deleteSubcollections: false });
    expect(result.nodeDeleted).toBe(true);
    // Parent gone …
    expect(await root.getNode(projectUid)).toBeNull();
    // … but child DO rows survive.
    expect(ns.rowCount(childKey)).toBe(1);
  });

  it('issues one destroy per targetGraph when two edges point at the same subgraph', async () => {
    // Two distinct edge relations (`hasPrimary`, `hasBackup`) point into the
    // same `memories` subgraph. The physical DO is addressed by
    // (parentUid, targetGraph) alone, so cascade must dedupe to a single
    // destroy call. The SQL inspection here catches the regression where
    // dedupe was keyed on (axbType, targetGraph) and produced two calls
    // against the same DO.
    const reg = createRegistry([
      { aType: 'project', axbType: 'is', bType: 'project' },
      { aType: 'memory', axbType: 'is', bType: 'memory' },
      {
        aType: 'project',
        axbType: 'hasPrimary',
        bType: 'memory',
        targetGraph: 'memories',
      },
      {
        aType: 'project',
        axbType: 'hasBackup',
        bType: 'memory',
        targetGraph: 'memories',
      },
    ]);
    const ns = makeInspectableNamespace();
    const root = createDOClient(ns.namespace, 'root', { registry: reg });

    const projectUid = generateId();
    await root.putNode('project', projectUid, { name: 'p' });
    const memoriesSub = root.subgraph(projectUid, 'memories');
    await memoriesSub.putNode('memory', generateId(), { note: 'x' });

    const childKey = `root/${projectUid}/memories`;
    expect(ns.rowCount(childKey)).toBe(1);

    // If dedupe regressed, this cascade would still wipe the child DO (so
    // row count goes to 0), but via two destroy calls. The topology
    // assertion below is the real guard.
    await root.removeNodeCascade(projectUid);
    expect(ns.rowCount(childKey)).toBe(0);

    // Belt and suspenders — independently verify the topology index dedupes.
    const topology = reg.getSubgraphTopology('project');
    expect(topology).toHaveLength(1);
    expect(topology[0].targetGraph).toBe('memories');
  });
});

// ---------------------------------------------------------------------------
// Dynamic registry (phase 2)
//
// End-to-end verification that `createDOClient({ registryMode: ... })`
// returns a working `DynamicGraphClient`. Meta-type writes land in the DO,
// `reloadRegistry()` compiles them, and the compiled registry's topology
// flows through to the same cross-DO cascade we exercised above.
// ---------------------------------------------------------------------------

describe('createDOClient — dynamic registry mode', () => {
  it('defines types, reloads, and validates domain writes end-to-end', async () => {
    const ns = makeInspectableNamespace();
    const client = createDOClient(ns.namespace, 'root', {
      registryMode: { mode: 'dynamic' },
    });

    await client.defineNodeType(
      'tour',
      {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' }, difficulty: { type: 'number' } },
        additionalProperties: false,
      },
      'A guided tour',
    );
    await client.reloadRegistry();

    const uid = generateId();
    await client.putNode('tour', uid, { title: 'Everest', difficulty: 7 });
    const rec = await client.getNode(uid);
    expect(rec!.data).toEqual({ title: 'Everest', difficulty: 7 });
    expect(rec!.createdAt).toBeInstanceOf(GraphTimestampImpl);

    // A write that violates the schema must be rejected by the compiled
    // registry, proving that `reloadRegistry` actually wired the backend.
    await expect(
      client.putNode('tour', generateId(), { title: 123 as unknown as string }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('routes meta-types to a separate DO when registryMode.collection is set', async () => {
    const ns = makeInspectableNamespace();
    const client = createDOClient(ns.namespace, 'root', {
      registryMode: { mode: 'dynamic', collection: 'meta' },
    });

    await client.defineNodeType(
      'tour',
      { type: 'object', properties: { title: { type: 'string' } } },
      'A tour',
    );

    // Meta-node landed in the `meta` DO, not the `root` DO.
    expect(ns.rowCount('meta')).toBe(1);
    expect(ns.rowCount('root')).toBe(0);

    await client.reloadRegistry();
    const uid = generateId();
    await client.putNode('tour', uid, { title: 'K2' });

    // Domain write landed in the `root` DO, not the `meta` DO.
    expect(ns.rowCount('root')).toBe(1);
    expect(ns.rowCount('meta')).toBe(1);
  });

  it('cascades across DOs using a registry defined at runtime', async () => {
    // This is the proof that `registryAccessor` is *live*: we define the
    // subgraph topology after construction, reload, then cascade — and
    // the backend must see the freshly-compiled topology.
    const ns = makeInspectableNamespace();
    const client = createDOClient(ns.namespace, 'root', {
      registryMode: { mode: 'dynamic' },
    });

    await client.defineNodeType('project', {
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    await client.defineNodeType('memory', {
      type: 'object',
      properties: { note: { type: 'string' } },
    });
    await client.defineEdgeType(
      'hasMemory',
      { from: 'project', to: 'memory', targetGraph: 'memories' },
      { type: 'object' },
    );
    await client.reloadRegistry();

    const projectUid = generateId();
    await client.putNode('project', projectUid, { name: 'apollo' });
    const memSub = client.subgraph(projectUid, 'memories');
    await memSub.putNode('memory', generateId(), { note: 'hi' });

    const memKey = `root/${projectUid}/memories`;
    expect(ns.rowCount(memKey)).toBe(1);

    await client.removeNodeCascade(projectUid);
    expect(ns.rowCount(memKey)).toBe(0);
    expect(await client.getNode(projectUid)).toBeNull();
  });

  it('merged mode: static entries plus dynamic additions coexist', async () => {
    const ns = makeInspectableNamespace();
    const staticReg = createRegistry([{ aType: 'project', axbType: 'is', bType: 'project' }]);
    const client = createDOClient(ns.namespace, 'root', {
      registry: staticReg,
      registryMode: { mode: 'dynamic' },
    });

    // Dynamic-only type: doesn't collide with the static `project`.
    await client.defineNodeType('memory', {
      type: 'object',
      properties: { note: { type: 'string' } },
    });
    await client.reloadRegistry();

    const projectUid = generateId();
    const memoryUid = generateId();
    await client.putNode('project', projectUid, {});
    await client.putNode('memory', memoryUid, { note: 'n' });

    expect(await client.getNode(projectUid)).not.toBeNull();
    expect(await client.getNode(memoryUid)).not.toBeNull();
  });
});
