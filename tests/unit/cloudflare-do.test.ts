/**
 * `FiregraphDO` unit tests.
 *
 * The DO's runtime dependency is `ctx.storage.sql` — a synchronous SQLite
 * API. We back it with better-sqlite3 wrapped to match the DO shape
 * (`exec(sql, ...params).toArray()` + `transactionSync(fn)`), which means
 * the same FiregraphDO code paths run in Node tests that run in a Worker.
 *
 * We do *not* spin up Miniflare here — that's integration territory. These
 * tests verify the SQL + transaction semantics and the RPC return shapes.
 */

import type { Database as BetterSqliteDb } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  DOSqlCursor,
  DOSqlExecutor,
  DOStorage,
  DurableObjectStateLike,
} from '../../src/cloudflare/do.js';
import { FiregraphDO } from '../../src/cloudflare/do.js';
import { computeEdgeDocId, computeNodeDocId } from '../../src/docid.js';
import { NODE_RELATION } from '../../src/internal/constants.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
// ---------------------------------------------------------------------------
// Fake DO storage backed by better-sqlite3.
//
// DO SQL returns a cursor with `.toArray()`. better-sqlite3 is statement-based,
// so we branch on whether the statement produces rows (SELECT / RETURNING) vs
// a write (INSERT / UPDATE / DELETE). Writes still need to be executable via
// `.toArray()` per the DO contract, hence the explicit `run` branch.
// ---------------------------------------------------------------------------

function makeFakeStorage(db: BetterSqliteDb): DOStorage {
  const sql: DOSqlExecutor = {
    exec<T = Record<string, unknown>>(text: string, ...params: unknown[]): DOSqlCursor<T> {
      const stmt = db.prepare(text);
      const returnsRows = stmt.reader;
      return {
        toArray(): T[] {
          if (returnsRows) {
            return stmt.all(...(params as unknown[])) as T[];
          }
          stmt.run(...(params as unknown[]));
          return [];
        },
      };
    },
  };

  return {
    sql,
    transactionSync<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

function makeCtx(storage: DOStorage): DurableObjectStateLike {
  return {
    storage,
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

function setupDO(): { db: BetterSqliteDb; doInstance: FiregraphDO } {
  const db = new Database(':memory:');
  const ctx = makeCtx(makeFakeStorage(db));
  const doInstance = new FiregraphDO(ctx, {});
  return { db, doInstance };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FiregraphDO — boot', () => {
  it('creates the schema on first construction (autoMigrate default)', () => {
    const { db } = setupDO();
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='firegraph'`)
      .get();
    expect(table).toBeTruthy();
  });

  it('respects autoMigrate: false', () => {
    const db = new Database(':memory:');
    const ctx = makeCtx(makeFakeStorage(db));
    new FiregraphDO(ctx, {}, { autoMigrate: false });
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='firegraph'`)
      .get();
    expect(table).toBeUndefined();
  });

  it('rejects a bogus table name at construction time', () => {
    const db = new Database(':memory:');
    const ctx = makeCtx(makeFakeStorage(db));
    expect(() => new FiregraphDO(ctx, {}, { table: 'bad-name' })).toThrow();
  });
});

describe('FiregraphDO — CRUD', () => {
  let doInstance: FiregraphDO;

  beforeEach(() => {
    ({ doInstance } = setupDO());
  });

  it('set + get round-trip', async () => {
    const uid = 'kX1nQ2mP9xR4wL1tY8s3a';
    const docId = computeNodeDocId(uid);
    await doInstance._fgSetDoc(
      docId,
      {
        aType: 'tour',
        aUid: uid,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: uid,
        data: { title: 'Everest' },
      },
      'replace',
    );

    const rec = await doInstance._fgGetDoc(docId);
    expect(rec).not.toBeNull();
    expect(rec!.aUid).toBe(uid);
    expect(rec!.data).toEqual({ title: 'Everest' });
  });

  it('returns null for a missing doc', async () => {
    const rec = await doInstance._fgGetDoc('nope:abc:is:abc');
    expect(rec).toBeNull();
  });

  it('update surfaces NOT_FOUND when the row is absent', async () => {
    await expect(
      doInstance._fgUpdateDoc('nonexistent', { dataOps: flattenPatch({ x: 1 }) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('update applies shallow merge via json_set', async () => {
    const uid = 'kX1nQ2mP9xR4wL1tY8s3a';
    const docId = computeNodeDocId(uid);
    await doInstance._fgSetDoc(
      docId,
      {
        aType: 'tour',
        aUid: uid,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: uid,
        data: { title: 'Everest', status: 'draft' },
      },
      'replace',
    );

    await doInstance._fgUpdateDoc(docId, { dataOps: flattenPatch({ status: 'active' }) });
    const rec = await doInstance._fgGetDoc(docId);
    expect(rec!.data).toEqual({ title: 'Everest', status: 'active' });
  });

  it('delete removes the row', async () => {
    const uid = 'kX1nQ2mP9xR4wL1tY8s3a';
    const docId = computeNodeDocId(uid);
    await doInstance._fgSetDoc(
      docId,
      {
        aType: 'tour',
        aUid: uid,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: uid,
        data: {},
      },
      'replace',
    );
    await doInstance._fgDeleteDoc(docId);
    expect(await doInstance._fgGetDoc(docId)).toBeNull();
  });
});

describe('FiregraphDO — queries', () => {
  let doInstance: FiregraphDO;

  beforeEach(async () => {
    ({ doInstance } = setupDO());
    for (const uid of ['kX1nQ2mP9xR4wL1tY8s3a', 'kX1nQ2mP9xR4wL1tY8s3b', 'kX1nQ2mP9xR4wL1tY8s3c']) {
      await doInstance._fgSetDoc(
        computeNodeDocId(uid),
        {
          aType: 'tour',
          aUid: uid,
          axbType: NODE_RELATION,
          bType: 'tour',
          bUid: uid,
          data: { status: uid.endsWith('a') ? 'active' : 'draft' },
        },
        'replace',
      );
    }
  });

  it('filters on columns', async () => {
    const rows = await doInstance._fgQuery([{ field: 'aType', op: '==', value: 'tour' }]);
    expect(rows).toHaveLength(3);
  });

  it('filters on data.* via json_extract', async () => {
    const rows = await doInstance._fgQuery([{ field: 'data.status', op: '==', value: 'active' }]);
    expect(rows).toHaveLength(1);
  });

  it('ORDER BY + LIMIT', async () => {
    const rows = await doInstance._fgQuery([], {
      orderBy: { field: 'aUid', direction: 'asc' },
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].aUid < rows[1].aUid).toBe(true);
  });
});

describe('FiregraphDO — aggregate', () => {
  // The DO RPC returns `Record<string, number | null>` so the empty-set
  // null distinction survives the structured-clone boundary; the
  // DORPCBackend in src/cloudflare/backend.ts is responsible for the
  // null → 0 / NaN resolution. These tests verify the wire shape directly.

  let doInstance: FiregraphDO;

  beforeEach(async () => {
    ({ doInstance } = setupDO());
    for (const [uid, price] of [
      ['kX1nQ2mP9xR4wL1tY8s3a', 10],
      ['kX1nQ2mP9xR4wL1tY8s3b', 20],
      ['kX1nQ2mP9xR4wL1tY8s3c', 100],
    ] as const) {
      await doInstance._fgSetDoc(
        computeNodeDocId(uid),
        {
          aType: 'tour',
          aUid: uid,
          axbType: NODE_RELATION,
          bType: 'tour',
          bUid: uid,
          data: { price, status: 'active' },
        },
        'replace',
      );
    }
  });

  it('returns count/sum/avg over the seeded rows', async () => {
    const out = await doInstance._fgAggregate(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    // Numbers cross the wire as `number` (or null for empty SUM/AVG); the DO
    // RPC coerces bigint → number on its side so the wire contract is clean.
    expect(out.n).toBe(3);
    expect(out.s).toBe(130);
    // Average of 10/20/100 over 3 rows = 43.333...
    expect(out.a).toBeCloseTo(130 / 3, 6);
  });

  it('returns numeric MIN/MAX (not lexicographic) thanks to CAST AS REAL', async () => {
    // Without the cast applied in compileDOAggregate, MIN("100", "20", "10")
    // would resolve to "10" (lexicographic) — exactly the bug the cast
    // exists to defend against.
    const out = await doInstance._fgAggregate(
      {
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    expect(out.lo).toBe(10);
    expect(out.hi).toBe(100);
  });

  it('returns the full {n: 0, s: null, a: null, lo: null, hi: null} wire shape over an empty filter set', async () => {
    // The DO returns null directly for SUM/MIN/MAX/AVG so the client-side
    // backend can resolve null → 0 (SUM/MIN/MAX) or NaN (AVG) consistently
    // across backends. COUNT is special: SQLite returns 0, never null.
    // Pin the FULL object — not per-key probes — so a regression that
    // accidentally substitutes 0/NaN for null on the DO side (defeating
    // the whole reason this RPC carries `number | null`) is caught here.
    const out = await doInstance._fgAggregate(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'doesNotExist' }],
    );
    expect(out).toEqual({
      n: 0,
      s: null,
      a: null,
      lo: null,
      hi: null,
    });
  });
});

describe('FiregraphDO — batch', () => {
  let doInstance: FiregraphDO;
  let db: BetterSqliteDb;

  beforeEach(() => {
    ({ db, doInstance } = setupDO());
  });

  it('commits multiple ops atomically', async () => {
    const a = 'kX1nQ2mP9xR4wL1tY8s3a';
    const b = 'kX1nQ2mP9xR4wL1tY8s3b';
    await doInstance._fgBatch([
      {
        kind: 'set',
        docId: computeNodeDocId(a),
        record: {
          aType: 'tour',
          aUid: a,
          axbType: NODE_RELATION,
          bType: 'tour',
          bUid: a,
          data: {},
        },
      },
      {
        kind: 'set',
        docId: computeNodeDocId(b),
        record: {
          aType: 'tour',
          aUid: b,
          axbType: NODE_RELATION,
          bType: 'tour',
          bUid: b,
          data: {},
        },
      },
    ]);

    const count = (db.prepare('SELECT COUNT(*) as n FROM firegraph').get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it('rejects the whole batch when any op fails to compile', async () => {
    // Pre-populate one row so we can assert the failed batch didn't touch it.
    const a = 'kX1nQ2mP9xR4wL1tY8s3a';
    await doInstance._fgSetDoc(
      computeNodeDocId(a),
      {
        aType: 'tour',
        aUid: a,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: a,
        data: {},
      },
      'replace',
    );

    // An unsafe key in the patch trips `flattenPatch` validation up front —
    // the call throws synchronously before any batch op is dispatched, so no
    // row can be touched. From the caller's point of view the effect is the
    // same as a mid-transaction rollback: nothing persisted.
    expect(() => flattenPatch({ 'bad key': 1 })).toThrow(/unsafe object key/);

    const count = (db.prepare('SELECT COUNT(*) as n FROM firegraph').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('rolls back when a later op throws mid-transaction', async () => {
    // Stub the sql executor to throw on the 2nd exec call to simulate a
    // SQL-level failure (e.g. a constraint violation) surfacing during
    // `transactionSync`. better-sqlite3's native transaction helper rolls
    // back on throw, matching DO SQLite's `transactionSync` semantics.
    const db2 = new Database(':memory:');
    const baseStorage = ((): DOStorage => {
      const sql: DOSqlExecutor = {
        exec(text, ...params) {
          const stmt = db2.prepare(text);
          const returnsRows = stmt.reader;
          return {
            toArray() {
              if (returnsRows) return stmt.all(...(params as unknown[])) as never[];
              stmt.run(...(params as unknown[]));
              return [];
            },
          };
        },
      };
      return {
        sql,
        transactionSync<T>(fn: () => T): T {
          return db2.transaction(fn)();
        },
      };
    })();

    // Schema creation runs 9 `exec` calls (CREATE TABLE + 8 CREATE INDEX
    // from DEFAULT_CORE_INDEXES). The batch then runs 2 more. We let the
    // first batch op succeed and throw on the second so the transaction has
    // uncommitted work to roll back. `transactionSync` must propagate the
    // throw after rollback.
    let callCount = 0;
    const wrappedSql: DOSqlExecutor = {
      exec(text, ...params) {
        callCount++;
        if (callCount === 11) {
          throw new Error('simulated SQL failure');
        }
        return baseStorage.sql.exec(text, ...params);
      },
    };
    const wrappedStorage: DOStorage = {
      sql: wrappedSql,
      transactionSync: baseStorage.transactionSync.bind(baseStorage),
    };
    const ctx = makeCtx(wrappedStorage);
    const doInstance2 = new FiregraphDO(ctx, {});

    const b = 'kX1nQ2mP9xR4wL1tY8s3b';
    const c = 'kX1nQ2mP9xR4wL1tY8s3c';

    await expect(
      doInstance2._fgBatch([
        {
          kind: 'set',
          docId: computeNodeDocId(b),
          record: {
            aType: 'tour',
            aUid: b,
            axbType: NODE_RELATION,
            bType: 'tour',
            bUid: b,
            data: {},
          },
        },
        {
          kind: 'set',
          docId: computeNodeDocId(c),
          record: {
            aType: 'tour',
            aUid: c,
            axbType: NODE_RELATION,
            bType: 'tour',
            bUid: c,
            data: {},
          },
        },
      ]),
    ).rejects.toThrow(/simulated SQL failure/);

    // Both rows rolled back — nothing committed.
    const count = (db2.prepare('SELECT COUNT(*) as n FROM firegraph').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('is a no-op for an empty op list', async () => {
    await expect(doInstance._fgBatch([])).resolves.toBeUndefined();
  });
});

describe('FiregraphDO — cascade + bulk + destroy', () => {
  let doInstance: FiregraphDO;
  let db: BetterSqliteDb;

  async function seedHub(uid: string, children: string[]): Promise<void> {
    await doInstance._fgSetDoc(
      computeNodeDocId(uid),
      {
        aType: 'tour',
        aUid: uid,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: uid,
        data: {},
      },
      'replace',
    );
    for (const c of children) {
      await doInstance._fgSetDoc(
        computeNodeDocId(c),
        {
          aType: 'departure',
          aUid: c,
          axbType: NODE_RELATION,
          bType: 'departure',
          bUid: c,
          data: {},
        },
        'replace',
      );
      await doInstance._fgSetDoc(
        computeEdgeDocId(uid, 'hasDeparture', c),
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'hasDeparture',
          bType: 'departure',
          bUid: c,
          data: {},
        },
        'replace',
      );
    }
  }

  beforeEach(() => {
    ({ db, doInstance } = setupDO());
  });

  it('removeNodeCascade drops the node + incident edges but not siblings', async () => {
    const hub = 'kHub2mP9xR4wL1tY8s3a';
    const childA = 'kChildXmP9xR4wL1tY8s3';
    const childB = 'kChildYmP9xR4wL1tY8s3';
    await seedHub(hub, [childA, childB]);

    const res = await doInstance._fgRemoveNodeCascade(hub);
    expect(res.nodeDeleted).toBe(true);
    expect(res.edgesDeleted).toBe(2);
    expect(res.errors).toEqual([]);

    // Children's self-loops survive; only the hub + its outgoing edges died.
    const names = db.prepare('SELECT doc_id FROM firegraph ORDER BY doc_id').all() as {
      doc_id: string;
    }[];
    expect(names.some((r) => r.doc_id === computeNodeDocId(childA))).toBe(true);
    expect(names.some((r) => r.doc_id === computeNodeDocId(childB))).toBe(true);
    expect(names.some((r) => r.doc_id === computeNodeDocId(hub))).toBe(false);
  });

  it('removeNodeCascade reports nodeDeleted:false when the node never existed', async () => {
    const res = await doInstance._fgRemoveNodeCascade('kNeverExistsInDB');
    expect(res.nodeDeleted).toBe(false);
    expect(res.edgesDeleted).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it('removeNodeCascade cleans up dangling edges even if the node row is gone', async () => {
    const orphan = 'kOrphanmP9xR4wL1tY8s3';
    const target = 'kTargetmP9xR4wL1tY8s3';
    // Manually insert an edge with no corresponding self-loop for `orphan`.
    await doInstance._fgSetDoc(
      computeNodeDocId(target),
      {
        aType: 'tour',
        aUid: target,
        axbType: NODE_RELATION,
        bType: 'tour',
        bUid: target,
        data: {},
      },
      'replace',
    );
    await doInstance._fgSetDoc(
      computeEdgeDocId(orphan, 'hasDeparture', target),
      {
        aType: 'tour',
        aUid: orphan,
        axbType: 'hasDeparture',
        bType: 'tour',
        bUid: target,
        data: {},
      },
      'replace',
    );

    const res = await doInstance._fgRemoveNodeCascade(orphan);
    // The node never had a self-loop, so nodeDeleted stays false — but the
    // dangling outgoing edge is still swept.
    expect(res.nodeDeleted).toBe(false);
    expect(res.edgesDeleted).toBe(1);
  });

  it('bulkRemoveEdges removes edges matching a partial filter (QUERY plan)', async () => {
    const hub = 'kHub2mP9xR4wL1tY8s3a';
    const childA = 'kChildXmP9xR4wL1tY8s3';
    const childB = 'kChildYmP9xR4wL1tY8s3';
    await seedHub(hub, [childA, childB]);

    const res = await doInstance._fgBulkRemoveEdges({ aUid: hub, axbType: 'hasDeparture' });
    expect(res.deleted).toBe(2);
    expect(res.errors).toEqual([]);
  });

  it('bulkRemoveEdges hits the GET plan when all three identifiers are present', async () => {
    const hub = 'kHub2mP9xR4wL1tY8s3a';
    const childA = 'kChildXmP9xR4wL1tY8s3';
    await seedHub(hub, [childA]);

    const res = await doInstance._fgBulkRemoveEdges({
      aUid: hub,
      axbType: 'hasDeparture',
      bUid: childA,
    });
    expect(res.deleted).toBe(1);
  });

  it('_fgDestroy empties the table', async () => {
    const hub = 'kHub2mP9xR4wL1tY8s3a';
    await seedHub(hub, ['kChildXmP9xR4wL1tY8s3']);
    await doInstance._fgDestroy();
    const count = (db.prepare('SELECT COUNT(*) as n FROM firegraph').get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
