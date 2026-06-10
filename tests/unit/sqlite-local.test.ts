/**
 * Tests for `firegraph/sqlite-local` — the better-sqlite3 file-backed
 * factory. Unlike the in-memory executor tests in sqlite-backend.test.ts,
 * these exercise real on-disk databases: persistence across close/reopen,
 * cascade table drops landing in the file, and pragma wiring.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/client.js';
import { generateId } from '../../src/id.js';
import { tableForScope } from '../../src/sqlite/catalog.js';
import { createBetterSqliteExecutor, createLocalSqliteBackend } from '../../src/sqlite/local.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'firegraph-sqlite-local-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  return join(dir, `${name}.db`);
}

describe('createLocalSqliteBackend', () => {
  it('opens a file database and persists data across close/reopen', async () => {
    const path = tempDbPath('persist');
    const uid = generateId();

    const first = await createLocalSqliteBackend(path);
    const client = createGraphClient(first.backend);
    await client.putNode('tour', uid, { name: 'Alps' });
    first.close();

    expect(existsSync(path)).toBe(true);

    const second = await createLocalSqliteBackend(path);
    const reopened = createGraphClient(second.backend);
    const node = await reopened.getNode(uid);
    expect(node?.data).toEqual({ name: 'Alps' });
    second.close();
  });

  it('supports :memory: databases', async () => {
    const { backend, close } = await createLocalSqliteBackend(':memory:');
    const client = createGraphClient(backend);
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'ephemeral' });
    expect((await client.getNode(uid))?.data).toEqual({ name: 'ephemeral' });
    close();
  });

  it('applies WAL journal mode and busy_timeout to path-opened databases', async () => {
    const path = tempDbPath('pragmas');
    const { db, close } = await createLocalSqliteBackend(path, { busyTimeoutMs: 1234 });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
    close();
  });

  it('applies caller-supplied pragmas after the defaults', async () => {
    const { db, close } = await createLocalSqliteBackend(tempDbPath('extra-pragmas'), {
      pragmas: { synchronous: 'NORMAL', cache_size: -2000 },
    });
    // synchronous NORMAL = 1
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('cache_size', { simple: true })).toBe(-2000);
    close();
  });

  it('rejects pragma names that are not valid identifiers', async () => {
    await expect(
      createLocalSqliteBackend(tempDbPath('bad-pragma'), {
        pragmas: { 'synchronous = 1; DROP TABLE x; --': 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('honors fileMustExist for missing files', async () => {
    await expect(
      createLocalSqliteBackend(tempDbPath('does-not-exist'), { fileMustExist: true }),
    ).rejects.toThrow();
  });

  it('rejects values that are neither a path nor a Database', async () => {
    await expect(createLocalSqliteBackend(42 as unknown as string)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('wraps an existing Database without closing it on close()', async () => {
    const db = new Database(tempDbPath('caller-owned'));
    const { backend, close } = await createLocalSqliteBackend(db);
    const client = createGraphClient(backend);
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'shared' });
    close();
    // Database stays open and usable — the caller owns its lifecycle.
    expect(db.open).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM firegraph').get()).toEqual({ n: 1 });
    db.close();
  });

  it('does not apply WAL to caller-provided databases', async () => {
    const db = new Database(tempDbPath('no-wal'));
    const { close } = await createLocalSqliteBackend(db);
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    close();
    db.close();
  });

  it('close() is idempotent', async () => {
    const handle = await createLocalSqliteBackend(tempDbPath('double-close'));
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it('declares core.transactions and runs interactive transactions', async () => {
    const { backend, close } = await createLocalSqliteBackend(tempDbPath('tx'));
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
    const { db, backend, close } = await createLocalSqliteBackend(tempDbPath('table-name'), {
      tableName: 'my_graph',
    });
    const client = createGraphClient(backend);
    await client.putNode('tour', generateId(), { name: 'x' });
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('my_graph');
    expect(tables).toContain('my_graph_graphs');
    close();
  });

  it('cascade delete drops subgraph tables inside the file', async () => {
    const path = tempDbPath('cascade');
    const { db, backend, close } = await createLocalSqliteBackend(path);
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
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM firegraph_graphs WHERE storage_scope != ''`).get(),
    ).toEqual({ n: 0 });
    close();

    // Reopen — the drop persisted to disk.
    const reopened = await createLocalSqliteBackend(path);
    const fresh = createGraphClient(reopened.backend);
    expect(await fresh.getNode(tour)).toBeNull();
    reopened.close();
  });

  it('two handles over the same file see each other’s writes (WAL)', async () => {
    const path = tempDbPath('two-handles');
    const writer = await createLocalSqliteBackend(path);
    const reader = await createLocalSqliteBackend(path);
    const uid = generateId();
    await createGraphClient(writer.backend).putNode('tour', uid, { name: 'shared' });
    const node = await createGraphClient(reader.backend).getNode(uid);
    expect(node?.data).toEqual({ name: 'shared' });
    writer.close();
    reader.close();
  });
});

describe('createBetterSqliteExecutor', () => {
  it('rolls back manual transactions when the callback rejects', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const executor = createBetterSqliteExecutor(db);

    await expect(
      executor.transaction!(async (tx) => {
        await tx.run('INSERT INTO t (v) VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });

    const result = await executor.transaction!(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', ['b']);
      return tx.all('SELECT v FROM t', []);
    });
    expect(result).toEqual([{ v: 'b' }]);
    db.close();
  });

  it('batch applies statements atomically', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)');
    const executor = createBetterSqliteExecutor(db);

    await expect(
      executor.batch([
        { sql: 'INSERT INTO t (v) VALUES (?)', params: ['x'] },
        { sql: 'INSERT INTO t (v) VALUES (?)', params: ['x'] }, // UNIQUE violation
      ]),
    ).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
    db.close();
  });
});
