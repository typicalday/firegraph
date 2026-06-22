/**
 * Tests for `firegraph/sqlite-builtin` — the node:sqlite (DatabaseSync) backed
 * factory. Unlike the in-memory executor tests in sqlite-backend.test.ts,
 * these exercise real on-disk databases: persistence across close/reopen,
 * cascade table drops landing in the file, and pragma wiring.
 *
 * Mirrors `sqlite-local.test.ts` exactly, adapted for the DatabaseSync driver.
 * All describe blocks that touch the database are skip-guarded on Node < 22.5
 * where node:sqlite is absent.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/client.js';
import { generateId } from '../../src/id.js';
import { tableForScope } from '../../src/sqlite/catalog.js';

// node:sqlite requires Node >= 22.5. Check by version.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const HAS_NODE_SQLITE = nodeMajor > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 5);

// These are populated dynamically inside HAS_NODE_SQLITE-guarded beforeAll blocks.
// They must NOT be imported statically — node:sqlite throws at load time on Node < 22.5.

let createNodeSqliteBackend: (...args: any[]) => Promise<any>;

let createNodeSqliteExecutor: (...args: any[]) => any;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'firegraph-sqlite-builtin-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  return join(dir, `${name}.db`);
}

describe.skipIf(!HAS_NODE_SQLITE)('createNodeSqliteBackend', () => {
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

  it('opens a file database and persists data across close/reopen', async () => {
    const path = tempDbPath('persist');
    const uid = generateId();

    const first = await createNodeSqliteBackend(path);
    const client = createGraphClient(first.backend);
    await client.putNode('tour', uid, { name: 'Alps' });
    first.close();

    expect(existsSync(path)).toBe(true);

    const second = await createNodeSqliteBackend(path);
    const reopened = createGraphClient(second.backend);
    const node = await reopened.getNode(uid);
    expect(node?.data).toEqual({ name: 'Alps' });
    second.close();
  });

  it('supports :memory: databases', async () => {
    const { backend, close } = await createNodeSqliteBackend(':memory:');
    const client = createGraphClient(backend);
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'ephemeral' });
    expect((await client.getNode(uid))?.data).toEqual({ name: 'ephemeral' });
    close();
  });

  it('applies WAL journal mode and busy_timeout to path-opened databases', async () => {
    const path = tempDbPath('pragmas');
    const { db, close } = await createNodeSqliteBackend(path, { busyTimeoutMs: 1234 });
    // node:sqlite uses db.prepare().get() instead of db.pragma()
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(jm.journal_mode).toBe('wal');
    // node:sqlite returns { timeout: N } for PRAGMA busy_timeout (not { busy_timeout: N })
    const bt = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(bt.timeout).toBe(1234);
    close();
  });

  it('applies caller-supplied pragmas after the defaults', async () => {
    const { db, close } = await createNodeSqliteBackend(tempDbPath('extra-pragmas'), {
      pragmas: { synchronous: 'NORMAL', cache_size: -2000 },
    });
    // synchronous NORMAL = 1
    const sync = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    expect(sync.synchronous).toBe(1);
    const cs = db.prepare('PRAGMA cache_size').get() as { cache_size: number };
    expect(cs.cache_size).toBe(-2000);
    close();
  });

  it('rejects pragma names that are not valid identifiers', async () => {
    await expect(
      createNodeSqliteBackend(tempDbPath('bad-pragma'), {
        pragmas: { 'synchronous = 1; DROP TABLE x; --': 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects pragma values that are not identifiers or integers', async () => {
    await expect(
      createNodeSqliteBackend(tempDbPath('bad-pragma-value'), {
        pragmas: { synchronous: '1; DROP TABLE x; --' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('honors fileMustExist for missing files', async () => {
    await expect(
      createNodeSqliteBackend(tempDbPath('does-not-exist'), { fileMustExist: true }),
    ).rejects.toThrow();
  });

  it('rejects values that are neither a path nor a DatabaseSync', async () => {
    await expect(createNodeSqliteBackend(42 as unknown as string)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('wraps an existing DatabaseSync without closing it on close()', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(tempDbPath('caller-owned'));
    const { backend, close } = await createNodeSqliteBackend(db);
    const client = createGraphClient(backend);
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'shared' });
    close();
    // DatabaseSync has no .open property — verify liveness by running a query.
    expect(() => db.prepare('SELECT COUNT(*) AS n FROM firegraph').get()).not.toThrow();
    const row = db.prepare('SELECT COUNT(*) AS n FROM firegraph').get() as { n: number };
    expect(row.n).toBe(1);
    db.close();
  });

  it('does not apply WAL to caller-provided databases', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(tempDbPath('no-wal'));
    const { close } = await createNodeSqliteBackend(db);
    const jm = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(jm.journal_mode).toBe('delete');
    close();
    db.close();
  });

  it('close() is idempotent', async () => {
    const handle = await createNodeSqliteBackend(tempDbPath('double-close'));
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it('declares core.transactions and runs interactive transactions', async () => {
    const { backend, close } = await createNodeSqliteBackend(tempDbPath('tx'));
    expect(backend.capabilities.has('core.transactions')).toBe(true);

    const client = createGraphClient(backend);
    const a = generateId();
    const b = generateId();
    await client.runTransaction(async (tx) => {
      await tx.putNode('tour', a, { name: 'A' });
      await tx.putNode('tour', b, { name: 'B' });
    });
    expect(await client.getNode(a)).not.toBeNull();
    expect(await client.getNode(b)).not.toBeNull();

    // A rejected callback rolls back both writes.
    const c = generateId();
    await expect(
      client.runTransaction(async (tx) => {
        await tx.putNode('tour', c, { name: 'C' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await client.getNode(c)).toBeNull();
    close();
  });

  it('uses a custom tableName for the root graph', async () => {
    const { db, backend, close } = await createNodeSqliteBackend(tempDbPath('table-name'), {
      tableName: 'my_graph',
    });
    const client = createGraphClient(backend);
    await client.putNode('tour', generateId(), { name: 'x' });
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toContain('my_graph');
    expect(tables).toContain('my_graph_graphs');
    close();
  });

  it('cascade delete drops subgraph tables inside the file', async () => {
    const path = tempDbPath('cascade');
    const { db, backend, close } = await createNodeSqliteBackend(path);
    const client = createGraphClient(backend);

    const tour = generateId();
    await client.putNode('tour', tour, { name: 'parent' });
    const memories = client.subgraph(tour, 'memories');
    await memories.putNode('note', generateId(), { text: 'hello' });

    const subTable = tableForScope('firegraph', `${tour}/memories`);
    const tableExists = (name: string): boolean =>
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
      undefined;
    expect(tableExists(subTable)).toBe(true);

    await client.removeNodeCascade(tour);
    expect(tableExists(subTable)).toBe(false);
    const graphsRow = db
      .prepare(`SELECT COUNT(*) AS n FROM firegraph_graphs WHERE storage_scope != ''`)
      .get() as { n: number };
    expect(graphsRow).toEqual({ n: 0 });
    close();

    // Reopen — the drop persisted to disk.
    const reopened = await createNodeSqliteBackend(path);
    const fresh = createGraphClient(reopened.backend);
    expect(await fresh.getNode(tour)).toBeNull();
    reopened.close();
  });

  it("two handles over the same file see each other's writes (WAL)", async () => {
    const path = tempDbPath('two-handles');
    const writer = await createNodeSqliteBackend(path);
    const reader = await createNodeSqliteBackend(path);
    const uid = generateId();
    await createGraphClient(writer.backend).putNode('tour', uid, { name: 'shared' });
    const node = await createGraphClient(reader.backend).getNode(uid);
    expect(node?.data).toEqual({ name: 'shared' });
    writer.close();
    reader.close();
  });
});

describe.skipIf(!HAS_NODE_SQLITE)('createNodeSqliteExecutor', () => {
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

  it('rolls back manual transactions when the callback rejects', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const executor = createNodeSqliteExecutor(db);

    await expect(
      executor.transaction!(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
    expect(after).toEqual({ n: 0 });

    const result = await executor.transaction!(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['b']);
      return tx.all('SELECT v FROM t', []);
    });
    expect(result).toEqual([{ v: 'b' }]);
    db.close();
  });

  it('batch applies statements atomically', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)');
    const executor = createNodeSqliteExecutor(db);

    await expect(
      executor.batch([
        { sql: 'INSERT INTO t (v) VALUES (?)', params: ['x'] },
        { sql: 'INSERT INTO t (v) VALUES (?)', params: ['x'] }, // UNIQUE violation
      ]),
    ).rejects.toThrow();
    const row = db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number };
    expect(row).toEqual({ n: 0 });
    db.close();
  });
});
