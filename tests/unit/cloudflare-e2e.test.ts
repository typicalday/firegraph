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

function makeNamespace(): FiregraphNamespace {
  const dos = new Map<string, FiregraphDO>();

  function instantiateDO(): FiregraphDO {
    const db = new Database(':memory:');
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

  return {
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
          doInstance = instantiateDO();
          dos.set(name, doInstance);
        }
        stub = wrapStubWithClone(doInstance);
        stubs.set(name, stub);
      }
      return stub;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDOClient + FiregraphDO — end-to-end', () => {
  it('round-trips a node through putNode + getNode', async () => {
    const client = createDOClient(makeNamespace(), 'root');
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
    const ns = makeNamespace();
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
    const client = createDOClient(makeNamespace(), 'root');
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
    const client = createDOClient(makeNamespace(), 'root');
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
    const client = createDOClient(makeNamespace(), 'root');
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

  it('findEdgesGlobal throws UNSUPPORTED_OPERATION via the client short-circuit', async () => {
    const client = createDOClient(makeNamespace(), 'root');
    await expect(client.findEdgesGlobal({ aType: 'tour' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('runTransaction throws UNSUPPORTED_OPERATION', async () => {
    const client = createDOClient(makeNamespace(), 'root');
    await expect(client.runTransaction(async () => 'x')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });
});
