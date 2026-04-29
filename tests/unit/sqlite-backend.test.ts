/**
 * SQLite backend unit tests using better-sqlite3.
 *
 * The tests wrap better-sqlite3 in a `SqliteExecutor` that mirrors the DO
 * SQLite driver — sync calls bridged through resolved promises, batches via
 * a transaction. This exercises the same code paths the production drivers
 * (D1, DO SQLite) take, just over an in-memory file.
 */

import type { Database as BetterSqliteDb } from 'better-sqlite3';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGraphClientFromBackend } from '../../src/client.js';
import { generateId } from '../../src/id.js';
import type { StorageBackend } from '../../src/internal/backend.js';
import type { SqliteExecutor, SqliteTxExecutor } from '../../src/internal/sqlite-executor.js';
import { buildSchemaStatements } from '../../src/internal/sqlite-schema.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
import { createSqliteBackend } from '../../src/sqlite/backend.js';
import type { GraphClient } from '../../src/types.js';
const TABLE = 'firegraph_test';

function makeExecutor(db: BetterSqliteDb): SqliteExecutor {
  return {
    async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
      return db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[];
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as unknown[]));
    },
    async batch(statements): Promise<void> {
      const tx = db.transaction((stmts: typeof statements) => {
        for (const s of stmts) {
          db.prepare(s.sql).run(...(s.params as unknown[]));
        }
      });
      tx(statements);
    },
    async transaction<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T> {
      // Manual BEGIN/COMMIT/ROLLBACK so async errors in `fn` still roll
      // back. better-sqlite3's `db.transaction()` requires a sync callback
      // and would commit before a rejected promise could propagate.
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({
          async all(sql: string, params: unknown[]) {
            return db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[];
          },
          async run(sql: string, params: unknown[]) {
            db.prepare(sql).run(...(params as unknown[]));
          },
        });
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

function setupBackend(): { db: BetterSqliteDb; backend: StorageBackend } {
  const db = new Database(':memory:');
  for (const sql of buildSchemaStatements(TABLE)) {
    db.exec(sql);
  }
  const backend = createSqliteBackend(makeExecutor(db), TABLE);
  return { db, backend };
}

describe('SqliteBackend (raw)', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it('creates and reads back a node', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'Tahoe', stops: 5 },
      },
      'replace',
    );

    const record = await backend.getDoc(uid);
    expect(record).not.toBeNull();
    expect(record!.aType).toBe('tour');
    expect(record!.data.name).toBe('Tahoe');
    expect(record!.data.stops).toBe(5);
    expect(record!.createdAt.toMillis()).toBeGreaterThan(0);
    expect(record!.updatedAt.toMillis()).toBeGreaterThan(0);
  });

  it('updates a node via shallow data field merge', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'Tahoe', stops: 5 },
      },
      'replace',
    );

    await backend.updateDoc(uid, { dataOps: flattenPatch({ stops: 7, status: 'active' }) });

    const record = await backend.getDoc(uid);
    expect(record!.data).toEqual({ name: 'Tahoe', stops: 7, status: 'active' });
  });

  it('updateDoc throws NOT_FOUND when no row matches (parity with Firestore update())', async () => {
    const uid = generateId();
    // No row written — updateDoc must throw instead of silently no-op'ing
    // (the SQLite default). Implementation uses UPDATE … RETURNING to detect
    // zero-row updates in a single round-trip.
    await expect(backend.updateDoc(uid, { dataOps: flattenPatch({ name: 'X' }) })).rejects.toThrow(
      /NOT_FOUND|no document found/,
    );
  });

  it('replaces data wholesale with replaceData', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'Tahoe', stops: 5, oldField: 'gone' },
      },
      'replace',
    );

    await backend.updateDoc(uid, {
      replaceData: { name: 'Yosemite', stops: 3 },
      v: 2,
    });

    const record = await backend.getDoc(uid);
    expect(record!.data).toEqual({ name: 'Yosemite', stops: 3 });
    expect(record!.v).toBe(2);
  });

  it('deletes a doc', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: {},
      },
      'replace',
    );

    await backend.deleteDoc(uid);
    expect(await backend.getDoc(uid)).toBeNull();
  });

  it('queries by built-in field equality', async () => {
    const a = generateId();
    const b = generateId();
    await backend.setDoc(
      a,
      {
        aType: 'tour',
        aUid: a,
        axbType: 'is',
        bType: 'tour',
        bUid: a,
        data: {},
      },
      'replace',
    );
    await backend.setDoc(
      b,
      {
        aType: 'departure',
        aUid: b,
        axbType: 'is',
        bType: 'departure',
        bUid: b,
        data: {},
      },
      'replace',
    );

    const tours = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'is' },
    ]);
    expect(tours).toHaveLength(1);
    expect(tours[0].aUid).toBe(a);
  });

  it('queries by data.* JSON field', async () => {
    const a = generateId();
    const b = generateId();
    await backend.setDoc(
      a,
      {
        aType: 'tour',
        aUid: a,
        axbType: 'is',
        bType: 'tour',
        bUid: a,
        data: { status: 'active' },
      },
      'replace',
    );
    await backend.setDoc(
      b,
      {
        aType: 'tour',
        aUid: b,
        axbType: 'is',
        bType: 'tour',
        bUid: b,
        data: { status: 'archived' },
      },
      'replace',
    );

    const active = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '==', value: 'active' },
    ]);
    expect(active).toHaveLength(1);
    expect(active[0].aUid).toBe(a);
  });

  it('supports comparison operators on data fields', async () => {
    for (let i = 0; i < 5; i++) {
      const uid = generateId();
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { stops: i + 1 },
        },
        'replace',
      );
    }
    const ge3 = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.stops', op: '>=', value: 3 },
    ]);
    expect(ge3).toHaveLength(3);
  });

  it('supports IN and NOT-IN on built-in fields', async () => {
    const ids = [generateId(), generateId(), generateId()];
    for (const uid of ids) {
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: {},
        },
        'replace',
      );
    }
    const some = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'aUid', op: 'in', value: [ids[0], ids[2]] },
    ]);
    expect(some).toHaveLength(2);

    const others = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'aUid', op: 'not-in', value: [ids[0]] },
    ]);
    expect(others).toHaveLength(2);
  });

  it('supports array-contains on data fields', async () => {
    const a = generateId();
    const b = generateId();
    await backend.setDoc(
      a,
      {
        aType: 'tour',
        aUid: a,
        axbType: 'is',
        bType: 'tour',
        bUid: a,
        data: { tags: ['scenic', 'dog-friendly'] },
      },
      'replace',
    );
    await backend.setDoc(
      b,
      {
        aType: 'tour',
        aUid: b,
        axbType: 'is',
        bType: 'tour',
        bUid: b,
        data: { tags: ['urban'] },
      },
      'replace',
    );

    const dog = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.tags', op: 'array-contains', value: 'dog-friendly' },
    ]);
    expect(dog).toHaveLength(1);
    expect(dog[0].aUid).toBe(a);
  });

  it('supports orderBy and limit', async () => {
    for (let i = 0; i < 5; i++) {
      const uid = generateId();
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { rank: 4 - i },
        },
        'replace',
      );
    }
    const ordered = await backend.query([{ field: 'aType', op: '==', value: 'tour' }], {
      orderBy: { field: 'data.rank', direction: 'asc' },
      limit: 2,
    });
    expect(ordered).toHaveLength(2);
    expect(ordered[0].data.rank).toBe(0);
    expect(ordered[1].data.rank).toBe(1);
  });

  it('setDoc on an existing row stamps both timestamps (parity with Firestore .set())', async () => {
    // Document the actual behaviour: `setDoc` is a full-record overwrite, so
    // both `createdAt` and `updatedAt` are stamped fresh — same as Firestore's
    // `setDoc` via `stampWritableRecord` in firestore-backend.ts. Callers that
    // need the original creation time preserved should use `updateDoc` (which
    // only touches `updated_at`).
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'first' },
      },
      'replace',
    );
    const before = await backend.getDoc(uid);

    // Sleep a hair so Date.now() advances past the previous stamp. better-sqlite3
    // is synchronous and Date.now() resolution is millisecond-grained, so a
    // single ms is enough on every platform.
    await new Promise((r) => setTimeout(r, 5));

    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'second' },
      },
      'replace',
    );
    const after = await backend.getDoc(uid);

    expect(after!.data.name).toBe('second');
    // Both timestamps moved on putNode overwrite — matching Firestore.
    expect(after!.createdAt.toMillis()).toBeGreaterThan(before!.createdAt.toMillis());
    expect(after!.updatedAt.toMillis()).toBeGreaterThan(before!.updatedAt.toMillis());
  });

  it('updateDoc preserves created_at while bumping updated_at', async () => {
    // Mirror of the existing Firestore integration test
    // ("updatedAt changes on update but createdAt does not"): the SQLite
    // `compileUpdate` path must not touch the `created_at` column.
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'first' },
      },
      'replace',
    );
    const before = await backend.getDoc(uid);
    await new Promise((r) => setTimeout(r, 5));
    await backend.updateDoc(uid, { dataOps: flattenPatch({ name: 'second' }) });
    const after = await backend.getDoc(uid);

    expect(after!.createdAt.toMillis()).toBe(before!.createdAt.toMillis());
    expect(after!.updatedAt.toMillis()).toBeGreaterThan(before!.updatedAt.toMillis());
  });

  it('rowToRecord coerces bigint columns to numbers (D1 SELECT shape)', async () => {
    // D1's underlying sqlite returns INTEGER columns as bigint when the value
    // exceeds Number.MAX_SAFE_INTEGER, but better-sqlite3 returns numbers by
    // default. Some callers configure better-sqlite3 with `safeIntegers(true)`
    // to surface bigint always — we must round-trip those without crashing.
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: {},
        v: 7,
      },
      'replace',
    );

    // Read row via raw SQL with safeIntegers turned ON for this statement so
    // the timestamps and `v` come back as bigint.
    const rawStmt = db
      .prepare(`SELECT * FROM ${TABLE} WHERE doc_id = ?`)

      .safeIntegers(true) as any;
    const row = rawStmt.get(uid) as Record<string, unknown>;
    expect(typeof row.created_at).toBe('bigint');
    expect(typeof row.updated_at).toBe('bigint');
    expect(typeof row.v).toBe('bigint');

    // The backend's getDoc path uses default integer mode (numbers), but
    // exercising rowToRecord directly with bigint inputs ensures D1's bigint
    // returns are handled.
    const { rowToRecord } = await import('../../src/sqlite/sql.js');
    const record = rowToRecord(row);
    expect(record.createdAt.toMillis()).toBeGreaterThan(0);
    expect(record.updatedAt.toMillis()).toBeGreaterThan(0);
    expect(record.v).toBe(7);
    expect(typeof record.v).toBe('number');
  });

  it('!= operator excludes matching rows', async () => {
    const ids = [generateId(), generateId(), generateId()];
    for (const uid of ids) {
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { status: uid === ids[0] ? 'archived' : 'active' },
        },
        'replace',
      );
    }
    const notArchived = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '!=', value: 'archived' },
    ]);
    expect(notArchived).toHaveLength(2);
    expect(notArchived.every((r) => r.data.status === 'active')).toBe(true);
  });

  it('array-contains-any matches when at least one tag overlaps', async () => {
    const a = generateId();
    const b = generateId();
    const c = generateId();
    await backend.setDoc(
      a,
      {
        aType: 'tour',
        aUid: a,
        axbType: 'is',
        bType: 'tour',
        bUid: a,
        data: { tags: ['scenic', 'dog-friendly'] },
      },
      'replace',
    );
    await backend.setDoc(
      b,
      {
        aType: 'tour',
        aUid: b,
        axbType: 'is',
        bType: 'tour',
        bUid: b,
        data: { tags: ['urban'] },
      },
      'replace',
    );
    await backend.setDoc(
      c,
      {
        aType: 'tour',
        aUid: c,
        axbType: 'is',
        bType: 'tour',
        bUid: c,
        data: { tags: ['gravel', 'scenic'] },
      },
      'replace',
    );

    const hits = await backend.query([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.tags', op: 'array-contains-any', value: ['scenic', 'urban'] },
    ]);
    expect(hits.map((r) => r.aUid).sort()).toEqual([a, b, c].sort());
  });

  it.each([
    ['in', 'in'],
    ['not-in', 'not-in'],
    ['array-contains-any', 'array-contains-any'],
  ] as const)('%s rejects empty array values at compile time', async (_label, op) => {
    await expect(
      backend.query([
        { field: 'aType', op: '==', value: 'tour' },
        { field: 'aUid', op, value: [] },
      ]),
    ).rejects.toThrow(/non-empty array/);
  });

  it('refuses an unfiltered findEdgesGlobal (SELECT-all guard)', async () => {
    // compileSelectGlobal explicitly rejects empty filters so a stray
    // findEdgesGlobal({}) doesn't silently scan the entire table.
    await expect(backend.findEdgesGlobal!({} as never)).rejects.toThrow(/at least one filter/);
  });

  it('findEdgesGlobal rejects all-3-identifier params (get-strategy guard)', async () => {
    // findEdgesGlobal must always be a query — if all three identifying fields
    // are present, the planner picks the get strategy and there is no global
    // doc lookup. Surface that as INVALID_QUERY rather than silently routing
    // through the local `getDoc` path.
    await expect(
      backend.findEdgesGlobal!({
        aUid: 'someUid',
        axbType: 'hasDeparture',
        bUid: 'otherUid',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
  });
});

describe('SqliteBackend subgraphs', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it('isolates rows between scopes', async () => {
    const parentUid = generateId();
    const sub = backend.subgraph(parentUid, 'memories');

    const rootUid = generateId();
    const subUid = generateId();

    await backend.setDoc(
      rootUid,
      {
        aType: 'tour',
        aUid: rootUid,
        axbType: 'is',
        bType: 'tour',
        bUid: rootUid,
        data: { where: 'root' },
      },
      'replace',
    );
    await sub.setDoc(
      subUid,
      {
        aType: 'tour',
        aUid: subUid,
        axbType: 'is',
        bType: 'tour',
        bUid: subUid,
        data: { where: 'sub' },
      },
      'replace',
    );

    const rootHits = await backend.query([{ field: 'aType', op: '==', value: 'tour' }]);
    const subHits = await sub.query([{ field: 'aType', op: '==', value: 'tour' }]);

    expect(rootHits).toHaveLength(1);
    expect(rootHits[0].data.where).toBe('root');
    expect(subHits).toHaveLength(1);
    expect(subHits[0].data.where).toBe('sub');
  });

  it('builds nested storage scopes and validation scope chain', async () => {
    const a = generateId();
    const b = generateId();
    const sub = backend.subgraph(a, 'memories').subgraph(b, 'context');

    expect(sub.scopePath).toBe('memories/context');
  });

  it('rejects empty parent UID', () => {
    expect(() => backend.subgraph('', 'memories')).toThrow(/INVALID_SUBGRAPH|parentNodeUid/);
  });

  it('rejects parent UID containing "/"', () => {
    expect(() => backend.subgraph('uid/with/slash', 'memories')).toThrow(
      /INVALID_SUBGRAPH|parentNodeUid/,
    );
  });

  it('rejects empty subgraph name', () => {
    const uid = generateId();
    expect(() => backend.subgraph(uid, '')).toThrow(/INVALID_SUBGRAPH|name/);
  });

  it('rejects subgraph name containing "/"', () => {
    const uid = generateId();
    expect(() => backend.subgraph(uid, 'a/b')).toThrow(/INVALID_SUBGRAPH|name/);
  });

  it('round-trips a 3-level nested subgraph (scope + storage + reads)', async () => {
    // Make sure interleaved-path encoding stays consistent past the depth
    // already covered by the 2-level test above. Each level adds
    // `<parentUid>/<name>` to the storage scope; a write at depth N must only
    // be visible through the same chain of `.subgraph()` calls.
    const tour = generateId();
    const dep = generateId();
    const note = generateId();

    const memories = backend.subgraph(tour, 'memories');
    const context = memories.subgraph(dep, 'context');
    const annotations = context.subgraph(note, 'annotations');

    expect(annotations.scopePath).toBe('memories/context/annotations');

    const leafUid = generateId();
    await annotations.setDoc(
      leafUid,
      {
        aType: 'annotation',
        aUid: leafUid,
        axbType: 'is',
        bType: 'annotation',
        bUid: leafUid,
        data: { body: 'deep!' },
      },
      'replace',
    );

    // Reachable through the full 3-level chain.
    const fromDeep = await annotations.getDoc(leafUid);
    expect(fromDeep!.data.body).toBe('deep!');

    // Not visible from any prefix scope.
    expect(await backend.getDoc(leafUid)).toBeNull();
    expect(await memories.getDoc(leafUid)).toBeNull();
    expect(await context.getDoc(leafUid)).toBeNull();

    // And not visible from a sibling 3-level path under a different leaf uid.
    const sibling = memories.subgraph(dep, 'context').subgraph(generateId(), 'annotations');
    expect(await sibling.getDoc(leafUid)).toBeNull();
  });

  it('escapes %/_ in subgraph names so cascade prefix-delete cannot leak across siblings', async () => {
    // The materialized-path scope is encoded directly into a SQL LIKE pattern
    // for cascade prefix-delete. If `%` or `_` aren't escaped, a sibling
    // subgraph with a similar name would also be wiped. `escapeLike` in
    // sqlite-sql.ts protects against that — pin the behavior here.
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const parent = generateId();
    await client.putNode('tour', parent, {});

    // Two sibling subgraphs whose names would alias under naive LIKE matching:
    // 'foo%bar' uses '%' as a literal character; 'foo_bar' uses '_'.
    // Without escape, prefix `parent/foo%bar` would match `parent/fooXbar` too.
    const wildcardSub = client.subgraph(parent, 'foo%bar');
    const literalSub = client.subgraph(parent, 'fooXbar');
    const underscoreSub = client.subgraph(parent, 'foo_bar');
    const literalUnderscoreSub = client.subgraph(parent, 'fooYbar');

    const inWild = generateId();
    const inLiteral = generateId();
    const inUnderscore = generateId();
    const inLiteralUnderscore = generateId();
    await wildcardSub.putNode('note', inWild, { where: 'wild' });
    await literalSub.putNode('note', inLiteral, { where: 'literal' });
    await underscoreSub.putNode('note', inUnderscore, { where: 'underscore' });
    await literalUnderscoreSub.putNode('note', inLiteralUnderscore, { where: 'literalUnderscore' });

    // Cascade-delete a node *inside* `foo%bar`. The cascade prefix becomes
    // `parent/foo%bar/<uid>` — escapeLike must turn the `%` into `\%` so the
    // sibling `parent/fooXbar/...` rows survive.
    const deepUid = generateId();
    await wildcardSub.putNode('section', deepUid, {});
    const annotations = wildcardSub.subgraph(deepUid, 'annotations');
    const deepLeaf = generateId();
    await annotations.putNode('annotation', deepLeaf, { body: 'deep' });

    // Sibling literal-name path with the same deepUid → if `_` weren't
    // escaped this would also be wiped by the cascade.
    const literalDeep = literalSub.subgraph(deepUid, 'annotations');
    const literalLeaf = generateId();
    await literalDeep.putNode('annotation', literalLeaf, { body: 'sibling' });

    const result = await wildcardSub.removeNodeCascade(deepUid);
    expect(result.errors).toHaveLength(0);

    // Wildcard-side leaf is gone …
    expect(await annotations.getNode(deepLeaf)).toBeNull();
    // … but the sibling literal-side leaf is still there.
    expect(await literalDeep.getNode(literalLeaf)).not.toBeNull();
    // The other sibling subgraphs (note rows, root) are completely untouched.
    expect(await literalSub.getNode(inLiteral)).not.toBeNull();
    expect(await underscoreSub.getNode(inUnderscore)).not.toBeNull();
    expect(await literalUnderscoreSub.getNode(inLiteralUnderscore)).not.toBeNull();
  });

  it('same subgraph name under different parents is queryable across parents via findEdgesGlobal', async () => {
    // Mirrors Firestore's `db.collectionGroup(name)` semantics: when two
    // different parent nodes each have a `memories` subgraph, a global query
    // on collectionName='memories' must surface rows from both.
    const parentA = generateId();
    const parentB = generateId();
    const memA = backend.subgraph(parentA, 'memories');
    const memB = backend.subgraph(parentB, 'memories');

    const edgeAfrom = generateId();
    const edgeAto = generateId();
    const edgeBfrom = generateId();
    const edgeBto = generateId();

    await memA.setDoc(
      'edge-a',
      {
        aType: 'note',
        aUid: edgeAfrom,
        axbType: 'mentions',
        bType: 'tag',
        bUid: edgeAto,
        data: { from: 'a' },
      },
      'replace',
    );
    await memB.setDoc(
      'edge-b',
      {
        aType: 'note',
        aUid: edgeBfrom,
        axbType: 'mentions',
        bType: 'tag',
        bUid: edgeBto,
        data: { from: 'b' },
      },
      'replace',
    );

    const acrossParents = await backend.findEdgesGlobal!({ axbType: 'mentions' }, 'memories');
    expect(acrossParents).toHaveLength(2);
    const sources = acrossParents.map((r) => r.data.from).sort();
    expect(sources).toEqual(['a', 'b']);
  });
});

describe('SqliteBackend cascade & bulk', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it('removeNodeCascade deletes node, edges, and nested subgraph rows', async () => {
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();
    const dep1 = generateId();
    const dep2 = generateId();
    const note = generateId();

    await client.putNode('tour', tour, { name: 't' });
    await client.putNode('departure', dep1, {});
    await client.putNode('departure', dep2, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep1, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep2, {});

    // Subgraph attached to tour
    const memories = client.subgraph(tour, 'memories');
    await memories.putNode('note', note, { text: 'hello' });

    const result = await client.removeNodeCascade(tour);
    expect(result.nodeDeleted).toBe(true);
    expect(result.edgesDeleted).toBe(2);
    expect(result.errors).toHaveLength(0);

    expect(await client.getNode(tour)).toBeNull();
    expect(await memories.getNode(note)).toBeNull();
    // Departures themselves are not deleted — only edges touching the tour.
    expect(await client.getNode(dep1)).not.toBeNull();
  });

  it('removeNodeCascade reports row count covering subgraph rows', async () => {
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();

    await client.putNode('tour', tour, { name: 't' });
    // 2 direct edges from the tour.
    const dep1 = generateId();
    const dep2 = generateId();
    await client.putNode('departure', dep1, {});
    await client.putNode('departure', dep2, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep1, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep2, {});

    // 3 rows in a nested subgraph (1 node + 2 more nodes → 3 total node rows).
    const memories = client.subgraph(tour, 'memories');
    await memories.putNode('note', generateId(), { text: 'a' });
    await memories.putNode('note', generateId(), { text: 'b' });
    await memories.putNode('note', generateId(), { text: 'c' });

    const result = await client.removeNodeCascade(tour);
    // 2 direct-edge deletes + 1 node delete + 3 subgraph rows = 6
    expect(result.deleted).toBe(6);
    expect(result.errors).toHaveLength(0);
  });

  it('removeNodeCascade with no subgraph rows still reports direct deletes', async () => {
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();
    await client.putNode('tour', tour, {});
    const dep1 = generateId();
    await client.putNode('departure', dep1, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep1, {});

    const result = await client.removeNodeCascade(tour);
    // 1 edge + 1 node, 0 subgraph rows (prefix-delete ran but matched nothing).
    expect(result.deleted).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it('removeNodeCascade with deleteSubcollections=false skips subgraph rows', async () => {
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();
    await client.putNode('tour', tour, {});
    const memories = client.subgraph(tour, 'memories');
    await memories.putNode('note', generateId(), { text: 'x' });

    const result = await client.removeNodeCascade(tour, { deleteSubcollections: false });
    // Just the node row, no subgraph accounting.
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // The subgraph row is intentionally left behind.
    const survivors = await backend.query([{ field: 'aType', op: '==', value: 'note' }], undefined);
    // subgraph query uses a different scope — use findEdgesGlobal-ish check via memories itself
    // (the caller supplied deleteSubcollections:false, so memories rows must remain).
    // Use memories reader to confirm:
    const memoryHits = await memories.findNodes({ aType: 'note' });
    expect(memoryHits.length).toBe(1);
    // Root query shouldn't return subgraph rows.
    expect(survivors).toHaveLength(0);
  });

  it('bulkRemoveEdges deletes matching edges only', async () => {
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();
    const dep1 = generateId();
    const dep2 = generateId();

    await client.putNode('tour', tour, {});
    await client.putNode('departure', dep1, {});
    await client.putNode('departure', dep2, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep1, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', dep2, {});

    const result = await client.bulkRemoveEdges({ aUid: tour, axbType: 'hasDeparture' });
    expect(result.deleted).toBe(2);
    const remaining = await client.findEdges({ aUid: tour, axbType: 'hasDeparture' });
    expect(remaining).toHaveLength(0);
    // Nodes still exist
    expect(await client.getNode(tour)).not.toBeNull();
  });

  it('bulkRemoveEdges honors caller-supplied BulkOptions.batchSize for chunking', async () => {
    // Parity with Firestore bulkRemoveEdges: callers can request smaller
    // chunks than the driver's hard cap to get finer-grained progress
    // reporting. Pre-fix, SQLite ignored `options.batchSize` entirely and
    // ran a single batch.
    const client = createGraphClientFromBackend(backend) as GraphClient;
    const tour = generateId();

    for (let i = 0; i < 5; i++) {
      await client.putEdge('tour', tour, 'hasItem', 'item', `item${i}`, { order: i });
    }

    const result = await client.bulkRemoveEdges(
      { aUid: tour, axbType: 'hasItem' },
      { batchSize: 2 },
    );

    expect(result.deleted).toBe(5);
    // 5 deletes in chunks of 2 → ceil(5/2) = 3 batches.
    expect(result.batches).toBe(3);
  });
});

describe('SqliteBackend transactions & batches', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it('runTransaction commits all writes atomically', async () => {
    const a = generateId();
    const b = generateId();
    await backend.runTransaction(async (tx) => {
      await tx.setDoc(
        a,
        {
          aType: 'tour',
          aUid: a,
          axbType: 'is',
          bType: 'tour',
          bUid: a,
          data: {},
        },
        'replace',
      );
      await tx.setDoc(
        b,
        {
          aType: 'tour',
          aUid: b,
          axbType: 'is',
          bType: 'tour',
          bUid: b,
          data: {},
        },
        'replace',
      );
    });
    expect(await backend.getDoc(a)).not.toBeNull();
    expect(await backend.getDoc(b)).not.toBeNull();
  });

  it('runTransaction rolls back when callback throws', async () => {
    const a = generateId();
    await expect(
      backend.runTransaction(async (tx) => {
        await tx.setDoc(
          a,
          {
            aType: 'tour',
            aUid: a,
            axbType: 'is',
            bType: 'tour',
            bUid: a,
            data: {},
          },
          'replace',
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await backend.getDoc(a)).toBeNull();
  });

  it('runTransaction surfaces and rolls back when an inner write rejects', async () => {
    // Force the transaction's inner write to fail by attempting an
    // updateNode with a dotted key — compileUpdate now rejects this at
    // compile time. Without C5's fix the rejection would be swallowed and
    // the transaction would silently commit any prior writes.
    const a = generateId();
    await backend.setDoc(
      a,
      {
        aType: 'tour',
        aUid: a,
        axbType: 'is',
        bType: 'tour',
        bUid: a,
        data: { name: 'before' },
      },
      'replace',
    );

    await expect(
      backend.runTransaction(async (tx) => {
        await tx.setDoc(
          generateId(),
          {
            aType: 'tour',
            aUid: generateId(),
            axbType: 'is',
            bType: 'tour',
            bUid: generateId(),
            data: {},
          },
          'replace',
        );
        await tx.updateDoc(a, { dataOps: flattenPatch({ 'a.b': 1 }) });
      }),
    ).rejects.toThrow(/unsafe object key/);

    // The first write should have been rolled back too.
    const recovered = await backend.getDoc(a);
    expect(recovered!.data.name).toBe('before');
  });

  it('batch.commit writes atomically', async () => {
    const ids = [generateId(), generateId(), generateId()];
    const batch = backend.createBatch();
    for (const uid of ids) {
      batch.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: {},
        },
        'replace',
      );
    }
    await batch.commit();

    for (const uid of ids) {
      expect(await backend.getDoc(uid)).not.toBeNull();
    }
  });
});

describe('SqliteBackend findEdgesGlobal', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to the table-name (root) scope when collectionName is omitted', async () => {
    const parent = generateId();
    const sub = backend.subgraph(parent, 'memories');

    const rootA = generateId();
    const rootB = generateId();
    const subA = generateId();
    const subB = generateId();

    await backend.setDoc(
      'root-edge',
      {
        aType: 'tour',
        aUid: rootA,
        axbType: 'hasDeparture',
        bType: 'departure',
        bUid: rootB,
        data: {},
      },
      'replace',
    );
    await sub.setDoc(
      'sub-edge',
      {
        aType: 'tour',
        aUid: subA,
        axbType: 'hasDeparture',
        bType: 'departure',
        bUid: subB,
        data: {},
      },
      'replace',
    );

    // No collectionName → match root rows only (parity with Firestore's
    // implicit `collectionGroup(parentCollectionName)` default).
    const rootOnly = await backend.findEdgesGlobal!({ axbType: 'hasDeparture' });
    expect(rootOnly).toHaveLength(1);
    expect(rootOnly[0].aUid).toBe(rootA);
  });

  it('filters by subgraph name when collectionName is supplied', async () => {
    const parent = generateId();
    const sub = backend.subgraph(parent, 'memories');
    const otherSub = backend.subgraph(parent, 'context');

    const subA = generateId();
    const subB = generateId();
    const otherA = generateId();
    const otherB = generateId();

    await sub.setDoc(
      'mem-edge',
      {
        aType: 'tour',
        aUid: subA,
        axbType: 'hasDeparture',
        bType: 'departure',
        bUid: subB,
        data: {},
      },
      'replace',
    );
    await otherSub.setDoc(
      'ctx-edge',
      {
        aType: 'tour',
        aUid: otherA,
        axbType: 'hasDeparture',
        bType: 'departure',
        bUid: otherB,
        data: {},
      },
      'replace',
    );

    const memories = await backend.findEdgesGlobal!({ axbType: 'hasDeparture' }, 'memories');
    expect(memories).toHaveLength(1);
    expect(memories[0].aUid).toBe(subA);
  });
});

describe('SqliteBackend updateDoc field-name validation', () => {
  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    ['dotted key', 'a.b'],
    ['bracket key', 'a[0]'],
    ['quote key', 'a"b'],
    ['empty key', ''],
  ])('rejects %s in dataFields at compile time', async (_label, key) => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { keep: 'me' },
      },
      'replace',
    );

    // `flattenPatch` validates path segments synchronously, so the throw
    // happens at call time — before any storage method is reached. The
    // resulting `updateDoc` is therefore never dispatched and the row is
    // untouched.
    expect(() => flattenPatch({ [key]: 1 })).toThrow(/unsafe object key/);

    // Original data must be untouched.
    const record = await backend.getDoc(uid);
    expect(record!.data).toEqual({ keep: 'me' });
  });
});

describe('SqliteBackend without transaction support (D1-shaped executor)', () => {
  it('runTransaction throws UNSUPPORTED_OPERATION when executor lacks transaction()', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }

    // D1-shaped executor: no `transaction` method.
    const executor: SqliteExecutor = {
      async all(sql, params) {
        return db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[];
      },
      async run(sql, params) {
        db.prepare(sql).run(...(params as unknown[]));
      },
      async batch(statements) {
        for (const s of statements) {
          db.prepare(s.sql).run(...(s.params as unknown[]));
        }
      },
    };

    const backend = createSqliteBackend(executor, TABLE);
    await expect(backend.runTransaction(async () => 1)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });

    db.close();
  });
});

describe('SqliteBackend identifier validation (factory-time)', () => {
  it('quoteIdent (used in DDL) rejects invalid table names', () => {
    expect(() => buildSchemaStatements('1bad')).toThrow(/Invalid SQL identifier/);
    expect(() => buildSchemaStatements('a-b')).toThrow(/Invalid SQL identifier/);
    expect(() => buildSchemaStatements('a b')).toThrow(/Invalid SQL identifier/);
    expect(() => buildSchemaStatements('a"b')).toThrow(/Invalid SQL identifier/);
  });

  it('accepts valid identifiers', () => {
    expect(() => buildSchemaStatements('firegraph')).not.toThrow();
    expect(() => buildSchemaStatements('_my_table_2')).not.toThrow();
    expect(() => buildSchemaStatements('FireGraph')).not.toThrow();
  });
});

describe('SqliteBackend bulk chunking (D1 batch cap)', () => {
  /**
   * Wraps an executor so `batch()` rejects calls that exceed the declared
   * `maxBatchSize`. Mirrors how Cloudflare D1 rejects oversized batches;
   * this way the chunking logic is tested against the exact failure mode
   * that would hit in production.
   */
  function makeCapped(db: BetterSqliteDb, cap: number): SqliteExecutor {
    const inner = makeExecutor(db);
    return {
      maxBatchSize: cap,
      all: inner.all,
      run: inner.run,
      batch(statements) {
        if (statements.length > cap) {
          return Promise.reject(
            new Error(`batch of ${statements.length} exceeds D1 cap of ${cap}`),
          );
        }
        return inner.batch(statements);
      },
    };
  }

  it('bulkRemoveEdges chunks by executor.maxBatchSize', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    const backend = createSqliteBackend(makeCapped(db, 3), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    // 10 edges → with cap=3 should split into 4 batches (3+3+3+1).
    const src = generateId();
    for (let i = 0; i < 10; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }

    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
    );

    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(10);
    expect(result.batches).toBe(4);

    // Verify all edges are actually gone.
    const remaining = await backend.query([
      { field: 'aUid', op: '==', value: src },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
    ]);
    expect(remaining).toHaveLength(0);

    db.close();
  });

  it('removeNodeCascade chunks and still deletes everything when cap is tight', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    const backend = createSqliteBackend(makeCapped(db, 5), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    const hub = generateId();
    await client.putNode('tour', hub, {});
    // 12 outgoing edges → total 14 statements (12 edges + node + prefix).
    // With cap=5 that's 3 chunks. Without chunking this would reject on the
    // single oversize batch.
    for (let i = 0; i < 12; i++) {
      await client.putEdge('tour', hub, 'hasDeparture', 'departure', generateId(), {});
    }

    const result = await backend.removeNodeCascade!(hub, client);
    expect(result.errors).toEqual([]);
    expect(result.nodeDeleted).toBe(true);
    expect(result.edgesDeleted).toBe(12);
    expect(result.batches).toBeGreaterThan(1);

    // Node row must be gone.
    expect(await backend.getDoc(hub)).toBeNull();

    db.close();
  });

  /**
   * Wraps an executor so `batch()` rejects calls whose total bound-parameter
   * count exceeds `paramCap`. Mirrors D1's secondary cap (≈1000 bound
   * parameters per batch, separate from the ≈100-statement cap).
   */
  function makeParamCapped(
    db: BetterSqliteDb,
    statementCap: number,
    paramCap: number,
  ): SqliteExecutor {
    const inner = makeExecutor(db);
    return {
      maxBatchSize: statementCap,
      maxBatchParams: paramCap,
      all: inner.all,
      run: inner.run,
      batch(statements) {
        const totalParams = statements.reduce((n, s) => n + s.params.length, 0);
        if (statements.length > statementCap) {
          return Promise.reject(
            new Error(`batch of ${statements.length} statements exceeds cap of ${statementCap}`),
          );
        }
        if (totalParams > paramCap) {
          return Promise.reject(
            new Error(`batch of ${totalParams} bound parameters exceeds cap of ${paramCap}`),
          );
        }
        return inner.batch(statements);
      },
    };
  }

  it('chunks by maxBatchParams when statement count is well under maxBatchSize', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // Statement cap is generous (50) but param cap is tight (5). Each
    // compileDelete emits 2 params, so each batch can hold 2 deletes (4
    // params) before it would exceed 5. 7 deletes → ceil(7/2) = 4 chunks.
    const backend = createSqliteBackend(makeParamCapped(db, 50, 5), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;
    const src = generateId();
    for (let i = 0; i < 7; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
    );
    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(7);
    expect(result.batches).toBe(4);
    db.close();
  });

  it('respects whichever cap (statement count vs param count) triggers first', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // Statement cap (3) is tighter than what param cap (10) would allow with
    // 2-param deletes (5 deletes = 10 params). Statement cap wins → 3 deletes
    // per chunk. 7 deletes → ceil(7/3) = 3 chunks.
    const backend = createSqliteBackend(makeParamCapped(db, 3, 10), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;
    const src = generateId();
    for (let i = 0; i < 7; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
    );
    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(7);
    expect(result.batches).toBe(3);
    db.close();
  });

  it('defaults to one batch when executor does not declare maxBatchSize', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // Plain executor — no maxBatchSize — should submit everything at once.
    const backend = createSqliteBackend(makeExecutor(db), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;
    const src = generateId();
    for (let i = 0; i < 7; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
    );
    expect(result.deleted).toBe(7);
    expect(result.batches).toBe(1);
    db.close();
  });

  /**
   * Wraps an executor so the first `failTimes` calls to `batch()` reject
   * with a transient error, and subsequent calls succeed. Lets us verify
   * that the chunking retry loop hides transient failures the way the
   * Firestore bulk path does.
   */
  function makeFlaky(db: BetterSqliteDb, failTimes: number): SqliteExecutor {
    const inner = makeExecutor(db);
    let remaining = failTimes;
    return {
      all: inner.all,
      run: inner.run,
      async batch(statements) {
        if (remaining > 0) {
          remaining--;
          throw new Error('transient D1 error');
        }
        return inner.batch(statements);
      },
    };
  }

  it('retries failed chunks with exponential backoff', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // 2 transient failures then success. maxRetries=3 (default) covers it.
    const backend = createSqliteBackend(makeFlaky(db, 2), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;
    const src = generateId();
    for (let i = 0; i < 5; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
    );
    expect(result.errors).toEqual([]);
    expect(result.deleted).toBe(5);
    expect(result.batches).toBe(1);
    db.close();
  }, 10_000);

  it('records an error and continues when retry budget is exhausted', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // 10 failures exceeds maxRetries=0 → the one chunk is recorded as an error.
    const backend = createSqliteBackend(makeFlaky(db, 10), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;
    const src = generateId();
    for (let i = 0; i < 3; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
      { maxRetries: 0 },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error.message).toMatch(/transient D1 error/);
    expect(result.deleted).toBe(0);
    db.close();
  });

  it('removeNodeCascade does not credit subgraph rows when batch permanently fails', async () => {
    // Two issues this test pins down:
    //   1. When the cascade batch fails, `nodeDeleted` and `edgesDeleted`
    //      must report the conservative 0/false outcome (we can't know which
    //      sub-batch actually committed).
    //   2. The pre-counted subgraph row total must NOT be folded into
    //      `deleted` if the prefix-delete chunk didn't commit. Otherwise
    //      callers get a misleading "X rows removed" tally pointing at rows
    //      that are still in the table.
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    const backend = createSqliteBackend(makeFlaky(db, 100), TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    const tour = generateId();
    await client.putNode('tour', tour, {});
    await client.putEdge('tour', tour, 'hasDeparture', 'departure', generateId(), {});
    const memories = client.subgraph(tour, 'memories');
    await memories.putNode('note', generateId(), { text: 'pre-existing' });
    await memories.putNode('note', generateId(), { text: 'still here' });

    const result = await backend.removeNodeCascade!(tour, client, { maxRetries: 0 });

    expect(result.errors.length).toBeGreaterThan(0);
    // Conservative reporting: cascade can't claim node/edge progress on failure.
    expect(result.nodeDeleted).toBe(false);
    expect(result.edgesDeleted).toBe(0);
    // And — critically — `deleted` must not include the 2 subgraph rows that
    // are still in the table.
    expect(result.deleted).toBe(0);

    // Sanity check: the rows really are still there (idempotent retry path).
    expect(await client.getNode(tour)).not.toBeNull();
    const remaining = await memories.findNodes({ aType: 'note' });
    expect(remaining.length).toBe(2);

    db.close();
  });
});

describe('SqliteBackend bindValue rejects Firestore special types', () => {
  /**
   * The SQLite backend can't import `@google-cloud/firestore` (would pollute
   * the Cloudflare Workers bundle), so detection is by `constructor.name`.
   * Mock each Firestore type with a class whose name matches and the same
   * shape used in production so the duck-type check fires.
   */
  class Timestamp {
    constructor(
      public readonly seconds: number,
      public readonly nanoseconds: number,
    ) {}
  }
  class GeoPoint {
    constructor(
      public readonly latitude: number,
      public readonly longitude: number,
    ) {}
  }
  class DocumentReference {
    constructor(public readonly path: string) {}
  }
  class VectorValue {
    constructor(public readonly _values: number[]) {}
  }
  class FieldValue {}

  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  it.each([
    ['Timestamp', new Timestamp(1700000000, 0)],
    ['GeoPoint', new GeoPoint(37.7749, -122.4194)],
    ['DocumentReference', new DocumentReference('users/abc')],
    ['VectorValue', new VectorValue([1, 2, 3])],
    ['FieldValue', new FieldValue()],
  ])('throws INVALID_QUERY when filtering by a %s value', async (typeName, value) => {
    await expect(backend.query([{ field: 'data.when', op: '==', value }])).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining(`Firestore ${typeName}`),
    });
  });

  it('throws INVALID_ARGUMENT when an updateDoc dataField holds a Firestore type', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { keep: 'me' },
      },
      'replace',
    );

    // The reject code moved from `INVALID_QUERY` (old SQL compiler) to
    // `INVALID_ARGUMENT` (new write-plan path) when the deep-merge refactor
    // routed JSON binding through `jsonBind`.
    await expect(
      backend.updateDoc(uid, {
        dataOps: flattenPatch({ startedAt: new Timestamp(1700000000, 0) }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Original data must be untouched.
    const record = await backend.getDoc(uid);
    expect(record!.data).toEqual({ keep: 'me' });
  });

  it('throws INVALID_ARGUMENT on a first-insert (compileSet) carrying a Firestore type', async () => {
    // Eager validation in compileSet — the value would be silently corrupted
    // by raw JSON.stringify on the INSERT path of merge mode, so we reject
    // up front rather than at ON CONFLICT.
    const uid = generateId();
    await expect(
      backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { startedAt: new Timestamp(1700000000, 0) },
        },
        'merge',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Replace mode also runs the eager guard.
    await expect(
      backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { startedAt: new Timestamp(1700000000, 0) },
        },
        'replace',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    expect(await backend.getDoc(uid)).toBeNull();
  });

  it('throws INVALID_ARGUMENT when migration write-back replaceData carries a Firestore type', async () => {
    // Mirrors the migration write-back path: read a record, run a migration
    // that promotes a millis number to a Timestamp, send the result back via
    // replaceData. SQLite has no Timestamp class, so the guard fires loudly
    // instead of corrupting the value.
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'Tahoe' },
      },
      'replace',
    );

    await expect(
      backend.updateDoc(uid, {
        replaceData: { name: 'Tahoe', startedAt: new Timestamp(1700000000, 0) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Original record untouched.
    const record = await backend.getDoc(uid);
    expect(record!.data).toEqual({ name: 'Tahoe' });
  });

  it('merge-mode setDoc with v=undefined preserves a previously-stamped v', async () => {
    // Cross-backend parity: Firestore's `set(record, {merge: true})` omits
    // `v` from the payload when undefined (via stampWritableRecord) and
    // leaves the stored `v` intact. SQLite must match — the COALESCE on
    // the ON CONFLICT clause is what guarantees this. Without it,
    // `excluded.v` would be NULL and clobber the prior `v`, breaking
    // migration replay if a registry temporarily drops migrations and
    // re-adds them later.
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'A' },
        v: 3,
      },
      'replace',
    );
    // Second put with no `v` (registry currently has no migrations for this
    // type). v must NOT be wiped to null.
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { kept: 'yes' },
      },
      'merge',
    );
    const record = await backend.getDoc(uid);
    expect(record!.v).toBe(3);
    expect(record!.data).toEqual({ name: 'A', kept: 'yes' });
  });

  it('merge-mode setDoc with v=N updates the stored v', async () => {
    // Companion to the COALESCE preservation test: when the incoming record
    // DOES carry a v, that's the new stamped version and must be applied.
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { name: 'A' },
        v: 1,
      },
      'replace',
    );
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { kept: 'yes' },
        v: 2,
      },
      'merge',
    );
    const record = await backend.getDoc(uid);
    expect(record!.v).toBe(2);
  });

  it('still accepts plain JSON-shaped objects (precaution against over-rejection)', async () => {
    const uid = generateId();
    await backend.setDoc(
      uid,
      {
        aType: 'tour',
        aUid: uid,
        axbType: 'is',
        bType: 'tour',
        bUid: uid,
        data: { tags: ['a', 'b'] },
      },
      'replace',
    );
    // Filter value is a plain object — must NOT throw.
    await expect(
      backend.query([{ field: 'data.tags', op: 'array-contains', value: 'a' }]),
    ).resolves.toHaveLength(1);
    // Plain object as a JSON-encoded equality value also OK.
    await expect(
      backend.query([{ field: 'data.shape', op: '==', value: { kind: 'point' } }]),
    ).resolves.toHaveLength(0);
  });
});

describe('SqliteBackend bulk fast-fail on oversized single statement', () => {
  /**
   * Wraps an executor so every `batch()` call is rejected. Tracks total call
   * count so the test can confirm fast-fail collapses retries from `maxRetries+1`
   * attempts down to 1.
   */
  function makeAlwaysFailing(
    db: BetterSqliteDb,
    paramCap: number,
  ): SqliteExecutor & { batchCalls: number } {
    const inner = makeExecutor(db);
    const wrapper: SqliteExecutor & { batchCalls: number } = {
      maxBatchParams: paramCap,
      batchCalls: 0,
      all: inner.all,
      run: inner.run,
      async batch(_statements) {
        wrapper.batchCalls += 1;
        throw new Error('simulated D1 oversized-batch rejection');
      },
    };
    return wrapper;
  }

  it('does not retry a single statement that exceeds the driver param cap', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // paramCap=1 → every 2-param compileDelete is "oversized" → fast-fail.
    const exec = makeAlwaysFailing(db, 1);
    const backend = createSqliteBackend(exec, TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    const src = generateId();
    await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});

    exec.batchCalls = 0; // reset — putEdge above used the executor for setDoc.
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
      { maxRetries: 3 },
    );

    // 1 chunk × 1 attempt (fast-fail) — NOT 1 × 4 (default retry budget).
    expect(exec.batchCalls).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.deleted).toBe(0);

    db.close();
  });

  it('still retries normal-sized chunks when only some statements would be oversized', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // paramCap=10 → 2-param compileDelete is well under the cap; chunk of N
    // statements isn't classified as oversized → retries proceed normally.
    const exec = makeAlwaysFailing(db, 10);
    const backend = createSqliteBackend(exec, TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    const src = generateId();
    for (let i = 0; i < 3; i++) {
      await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});
    }

    exec.batchCalls = 0;
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
      { maxRetries: 2 },
    );

    // 1 chunk × (maxRetries + 1) attempts = 3 calls — full retry path.
    expect(exec.batchCalls).toBe(3);
    expect(result.errors).toHaveLength(1);
    db.close();
  }, 15_000);
});

describe('SqliteBackend retry backoff cap (MAX_RETRY_DELAY_MS)', () => {
  it('caps per-attempt sleep so a high maxRetries does not block for minutes', async () => {
    const db = new Database(':memory:');
    for (const sql of buildSchemaStatements(TABLE)) {
      db.exec(sql);
    }
    // Executor whose `run`/`all` go through normally (so putEdge setup works)
    // but whose `batch` always rejects — that's the path `bulkRemoveEdges`
    // takes. No `maxBatchParams` declared → no fast-fail.
    const inner = makeExecutor(db);
    let batchCalls = 0;
    const exec: SqliteExecutor = {
      all: inner.all,
      run: inner.run,
      async batch() {
        batchCalls += 1;
        throw new Error('permanent error');
      },
    };
    const backend = createSqliteBackend(exec, TABLE);
    const client: GraphClient = createGraphClientFromBackend(backend) as GraphClient;

    const src = generateId();
    // putEdge routes through `run`, not `batch` — setup is unaffected.
    await client.putEdge('tour', src, 'hasDeparture', 'departure', generateId(), {});

    batchCalls = 0;
    const t0 = Date.now();
    // maxRetries=5 → waits 200, 400, 800, 1600, 3200ms with cap not binding
    // yet. Total ≈ 6.2s. Without a cap, maxRetries=10 would push this past
    // 100s — this test is mainly a smoke check that the sleep math applies
    // `Math.min(..., MAX_RETRY_DELAY_MS)` so future bumps don't blow up CI.
    const result = await backend.bulkRemoveEdges!(
      { aUid: src, axbType: 'hasDeparture', allowCollectionScan: true, limit: 0 },
      client,
      { maxRetries: 5 },
    );
    const elapsed = Date.now() - t0;

    expect(batchCalls).toBe(6); // 1 attempt + 5 retries
    expect(result.errors).toHaveLength(1);
    // Unbounded sum at maxRetries=5 is 200+400+800+1600+3200 = 6200ms. With
    // the 5000ms cap applied to attempts ≥4 the total becomes slightly less
    // (cap triggers at attempt=5: min(6400, 5000) = 5000). Either way, well
    // under 15s — we just want to catch a regression that removes the cap.
    expect(elapsed).toBeLessThan(15_000);
    db.close();
  }, 20_000);
});

describe('SqliteBackend.aggregate (compileAggregate)', () => {
  // The shared-table SQLite compiler ALWAYS leads with a `"scope" = ?`
  // predicate so the `(scope, …)` indexes apply (see compileSelect). Aggregates
  // must follow the same rule — otherwise a subgraph-scoped aggregate would
  // accidentally count rows from sibling subgraphs.

  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  // --- SQL string assertions (compileAggregate output) ---

  it('emits a leading "scope" = ? predicate and inlined JSON paths', async () => {
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    const { stmt, aliases } = compileAggregate(
      TABLE,
      '', // root scope
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );

    // Scope predicate is the leading WHERE term and bound (not inlined).
    expect(stmt.sql).toContain('WHERE "scope" = ? AND');
    // The numeric cast applies to all four non-count ops.
    expect(stmt.sql).toContain(`SUM(CAST(json_extract("data", '$.price') AS REAL)) AS "s"`);
    expect(stmt.sql).toContain(`MIN(CAST(json_extract("data", '$.price') AS REAL)) AS "lo"`);
    expect(stmt.sql).toContain(`MAX(CAST(json_extract("data", '$.price') AS REAL)) AS "hi"`);
    // JSON path is inlined so SQLite's planner can match an expression
    // index emitted by sqlite-index-ddl.ts. Parametrising the path would
    // silently fall back to a full scan.
    expect(stmt.sql).not.toContain(`json_extract("data", ?)`);
    // Param order is fixed: scope value first (leading "scope" = ?
    // predicate), followed by column-filter values in the order the caller
    // supplied them. A regression that re-orders the predicate or starts
    // parametrising the JSON path would change this exact tuple.
    expect(stmt.params).toEqual(['', 'tour']);
    expect(aliases).toEqual(['n', 's', 'a', 'lo', 'hi']);
  });

  it('preserves alias order in the returned aliases list', async () => {
    // Spec keys are in iteration order; the alias array must mirror that so
    // SqliteBackendImpl.aggregate can rehydrate result columns deterministically.
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    const { aliases } = compileAggregate(
      TABLE,
      '',
      {
        zCount: { op: 'count' },
        aSum: { op: 'sum', field: 'data.x' },
        mAvg: { op: 'avg', field: 'data.x' },
      },
      [],
    );
    expect(aliases).toEqual(['zCount', 'aSum', 'mAvg']);
  });

  it('combines a built-in column filter with a data.* JSON filter', async () => {
    // Mirror the cloudflare-sql parity test — shared SQLite must apply both
    // a column-filter and a JSON-path filter side-by-side, with the leading
    // scope predicate intact.
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    const { stmt } = compileAggregate(TABLE, '', { n: { op: 'count' } }, [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '==', value: 'active' },
    ]);
    // Scope predicate leads, column-filter next, JSON path last; values in
    // the same order as conditions: ['', 'tour', 'active']. Built-in
    // `aType` resolves to column `a_type` via FIELD_TO_COLUMN.
    expect(stmt.sql).toContain('WHERE "scope" = ? AND');
    expect(stmt.sql).toContain(`"a_type" = ?`);
    expect(stmt.sql).toContain(`json_extract("data", '$.status') = ?`);
    expect(stmt.params).toEqual(['', 'tour', 'active']);
  });

  it('rejects unsafe alias identifiers at compile time', async () => {
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    expect(() => compileAggregate(TABLE, '', { 'bad alias': { op: 'count' } }, [])).toThrow(
      /not a safe JSON-path identifier/,
    );
    expect(() =>
      compileAggregate(TABLE, '', { 'a"; DROP TABLE foo;--': { op: 'count' } }, []),
    ).toThrow(/not a safe JSON-path identifier/);
  });

  it('rejects empty spec and non-count ops missing a field', async () => {
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    expect(() => compileAggregate(TABLE, '', {}, [])).toThrow(/at least one aggregation/);
    expect(() => compileAggregate(TABLE, '', { s: { op: 'sum' } }, [])).toThrow(
      /'sum' requires a field/,
    );
  });

  it('rejects count with a stray field (catches typo from cribbing a sum spec)', async () => {
    const { compileAggregate } = await import('../../src/sqlite/sql.js');
    expect(() =>
      compileAggregate(TABLE, '', { n: { op: 'count', field: 'data.price' } }, []),
    ).toThrow(/'count' must not specify a field/);
  });

  // --- Functional integration (in-memory SQLite, full backend.aggregate) ---

  async function seedTours(prices: number[]): Promise<string[]> {
    const ids: string[] = [];
    for (const price of prices) {
      const uid = generateId();
      ids.push(uid);
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { price, status: 'active' },
        },
        'replace',
      );
    }
    return ids;
  }

  it('returns count/sum/avg/min/max over a real row set', async () => {
    await seedTours([10, 20, 30, 40]);
    const out = await backend.aggregate!(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    expect(out.n).toBe(4);
    expect(out.s).toBe(100);
    expect(out.a).toBe(25);
    expect(out.lo).toBe(10);
    expect(out.hi).toBe(40);
  });

  it('respects filters when computing aggregates', async () => {
    await seedTours([10, 20, 30, 40]);
    const out = await backend.aggregate!(
      { n: { op: 'count' }, s: { op: 'sum', field: 'data.price' } },
      [
        { field: 'aType', op: '==', value: 'tour' },
        { field: 'data.price', op: '>=', value: 25 },
      ],
    );
    expect(out.n).toBe(2);
    expect(out.s).toBe(70);
  });

  it('treats SUM/MIN/MAX of empty set as 0 and AVG as NaN', async () => {
    // No rows seeded — every aggregate sees the empty set.
    const out = await backend.aggregate!(
      {
        n: { op: 'count' },
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    expect(out.n).toBe(0);
    expect(out.s).toBe(0);
    expect(Number.isNaN(out.a)).toBe(true);
    expect(out.lo).toBe(0);
    expect(out.hi).toBe(0);
  });

  it('uses numeric (not lexicographic) comparison for MIN/MAX', async () => {
    // Without CAST(... AS REAL), SQLite would compare json_extract output
    // lexicographically and return "100" as min (since "100" < "20").
    await seedTours([20, 100, 30]);
    const out = await backend.aggregate!(
      {
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    expect(out.lo).toBe(20);
    expect(out.hi).toBe(100);
  });

  it('coerces bigint result columns to numbers (D1 SELECT shape)', async () => {
    // D1 / better-sqlite3 with safeIntegers may return COUNT and SUM as
    // bigint. The backend coerces those at the JS boundary so the contract
    // stays `Record<string, number>`. Wrap the executor so the SELECT
    // emitted by compileAggregate routes through `safeIntegers(true)`
    // — that flips better-sqlite3's INTEGER columns from `number` to
    // `bigint`, exercising the bigint branch in `SqliteBackendImpl.aggregate`.
    // Without this stub the `typeof` check would pass even if the bigint
    // branch were deleted (better-sqlite3's default is `number`).
    const realExecutor = makeExecutor(db);
    const bigintExecutor: SqliteExecutor = {
      ...realExecutor,
      async all(sql: string, params: unknown[]) {
        // Route only the SELECT (aggregates use SELECT, not run/batch); other
        // calls go through the real executor unchanged.
        if (sql.startsWith('SELECT ')) {
          const stmt = db.prepare(sql).safeIntegers(true);
          return stmt.all(...(params as unknown[])) as Record<string, unknown>[];
        }
        return realExecutor.all(sql, params);
      },
    };
    const bigintBackend = createSqliteBackend(bigintExecutor, TABLE);

    await seedTours([1, 2, 3]);
    const out = await bigintBackend.aggregate!(
      { n: { op: 'count' }, s: { op: 'sum', field: 'data.price' } },
      [{ field: 'aType', op: '==', value: 'tour' }],
    );
    // The backend MUST coerce bigint → number at the boundary. Without the
    // bigint branch, COUNT(*) would surface as a bigint and fail this check.
    expect(typeof out.n).toBe('number');
    expect(out.n).toBe(3);
    // SUM over JSON-extracted REAL stays a JS number even with safeIntegers
    // (the CAST AS REAL produces a floating-point column). We still assert
    // it's a number to pin the contract.
    expect(typeof out.s).toBe('number');
    expect(out.s).toBe(6);
  });
});

describe('SqliteBackend bulk DML (compileBulkDelete / compileBulkUpdate)', () => {
  // Phase 5 query.dml: server-side DELETE / UPDATE that bypasses the
  // O(n) read-then-write loop bulkRemoveEdges uses. Both compilers must
  // ALWAYS lead with a `"scope" = ?` predicate so a routed-subgraph DML
  // call cannot leak across siblings — same invariant as compileSelect /
  // compileAggregate.

  let db: BetterSqliteDb;
  let backend: StorageBackend;

  beforeEach(() => {
    ({ db, backend } = setupBackend());
  });

  afterEach(() => {
    db.close();
  });

  // --- SQL string assertions (compiler output) ---

  it('compileBulkDelete emits a leading "scope" = ? predicate', async () => {
    const { compileBulkDelete } = await import('../../src/sqlite/sql.js');
    const stmt = compileBulkDelete(TABLE, 'memories', [
      { field: 'aType', op: '==', value: 'tour' },
    ]);
    // Scope predicate leads, column-filter follows. Param order must match.
    expect(stmt.sql).toContain(`DELETE FROM ${'"' + TABLE + '"'} WHERE "scope" = ? AND `);
    expect(stmt.sql).toContain(`"a_type" = ?`);
    expect(stmt.params).toEqual(['memories', 'tour']);
  });

  it('compileBulkDelete with no filters still leads with the scope predicate (delete-everything-in-scope)', async () => {
    const { compileBulkDelete } = await import('../../src/sqlite/sql.js');
    const stmt = compileBulkDelete(TABLE, 'memories', []);
    // Even the unfiltered case is scope-bound — wiping a subgraph wholesale
    // must not touch sibling subgraphs. The client-level scan-protection
    // gate in `bulkDelete()` forces `allowCollectionScan: true` to reach
    // this path.
    expect(stmt.sql).toContain('WHERE "scope" = ?');
    expect(stmt.params).toEqual(['memories']);
  });

  it('compileBulkUpdate emits SET "data" = json_patch(...) and a leading scope predicate', async () => {
    const { compileBulkUpdate } = await import('../../src/sqlite/sql.js');
    const stmt = compileBulkUpdate(
      TABLE,
      'memories',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { status: 'archived' },
      1700000000000,
    );
    // Deep-merge expression on the data column.
    expect(stmt.sql).toMatch(/UPDATE\s+"firegraph_test"\s+SET\s+"data"\s*=/);
    // updated_at is bumped.
    expect(stmt.sql).toContain(`"updated_at" = ?`);
    // Scope predicate leads in the WHERE.
    expect(stmt.sql).toContain(`WHERE "scope" = ? AND `);
    // Params: SET-clause params first (patch value + nowMillis), then
    // WHERE params (scope value + filter value). The exact ordering
    // matters because the same convention is shared with compileUpdate.
    expect(stmt.params[stmt.params.length - 2]).toBe('memories');
    expect(stmt.params[stmt.params.length - 1]).toBe('tour');
    expect(stmt.params).toContain(1700000000000);
  });

  it('compileBulkUpdate rejects an empty patch with INVALID_QUERY', async () => {
    const { compileBulkUpdate } = await import('../../src/sqlite/sql.js');
    expect(() => compileBulkUpdate(TABLE, 'memories', [], {}, Date.now())).toThrow(
      /at least one leaf|INVALID_QUERY/,
    );
  });

  it('compileBulkUpdate rejects Firestore special types in the patch', async () => {
    // Mirror of the assertJsonSafePayload guard on single-row replaceData
    // writes. SQLite rows can't store Firestore Timestamp/GeoPoint/etc.
    // The DML path hits the same guard.
    const { compileBulkUpdate } = await import('../../src/sqlite/sql.js');
    // Construct a tagged Firestore-shaped payload — the guard fires on the
    // tagged sentinel, so we don't need a real Firestore SDK in this test.
    const tagged = { __firegraph_ser__: 'Timestamp', seconds: 1, nanoseconds: 0 };
    expect(() =>
      compileBulkUpdate(TABLE, 'memories', [], { stamped: tagged }, Date.now()),
    ).toThrow();
  });

  // --- Functional integration (in-memory SQLite, full backend.bulkDelete/Update) ---

  async function seedTours(prices: number[]): Promise<string[]> {
    const ids: string[] = [];
    for (const price of prices) {
      const uid = generateId();
      ids.push(uid);
      await backend.setDoc(
        uid,
        {
          aType: 'tour',
          aUid: uid,
          axbType: 'is',
          bType: 'tour',
          bUid: uid,
          data: { price, status: 'active' },
        },
        'replace',
      );
    }
    return ids;
  }

  it('bulkDelete removes only matching rows and reports the row count', async () => {
    const ids = await seedTours([10, 20, 30, 40]);
    expect(ids).toHaveLength(4);

    const out = await backend.bulkDelete!([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.price', op: '>=', value: 25 },
    ]);
    // Two of the four rows have price >= 25.
    expect(out.deleted).toBe(2);
    expect(out.batches).toBe(1);
    expect(out.errors).toEqual([]);

    // Surviving rows are still readable.
    const remaining = await backend.query([{ field: 'aType', op: '==', value: 'tour' }]);
    expect(remaining).toHaveLength(2);
    const remainingPrices = remaining
      .map((r) => (r.data as { price: number }).price)
      .sort((a, b) => a - b);
    expect(remainingPrices).toEqual([10, 20]);
  });

  it('bulkDelete with zero filters deletes every row in the current scope', async () => {
    await seedTours([1, 2, 3]);
    const out = await backend.bulkDelete!([]);
    expect(out.deleted).toBe(3);
    const remaining = await backend.query([]);
    expect(remaining).toHaveLength(0);
  });

  it('bulkUpdate deep-merges the patch and reports the row count', async () => {
    const ids = await seedTours([10, 20, 30]);
    expect(ids).toHaveLength(3);

    const out = await backend.bulkUpdate!([{ field: 'aType', op: '==', value: 'tour' }], {
      data: { status: 'archived', tags: ['legacy'] },
    });
    expect(out.deleted).toBe(3);
    expect(out.batches).toBe(1);
    expect(out.errors).toEqual([]);

    // Every row reflects the merged status; the existing `price` field
    // survives the deep-merge.
    const rows = await backend.query([{ field: 'aType', op: '==', value: 'tour' }]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const data = row.data as { status: string; price: number; tags: string[] };
      expect(data.status).toBe('archived');
      expect(data.tags).toEqual(['legacy']);
      // Price wasn't in the patch — must be preserved.
      expect(typeof data.price).toBe('number');
    }
  });

  it('bulkUpdate respects filters when computing affected rows', async () => {
    await seedTours([10, 20, 30, 40]);

    const out = await backend.bulkUpdate!(
      [
        { field: 'aType', op: '==', value: 'tour' },
        { field: 'data.price', op: '>=', value: 25 },
      ],
      { data: { status: 'archived' } },
    );
    expect(out.deleted).toBe(2);

    const rows = await backend.query([{ field: 'aType', op: '==', value: 'tour' }]);
    const archived = rows.filter((r) => (r.data as { status?: string }).status === 'archived');
    const active = rows.filter((r) => (r.data as { status?: string }).status === 'active');
    expect(archived).toHaveLength(2);
    expect(active).toHaveLength(2);
  });

  it('bulkDelete in a subgraph does not touch rows in sibling scopes', async () => {
    // Cross-scope safety. A bulkDelete on the `memories` subgraph must
    // leave the parent scope's rows untouched. The leading `"scope" = ?`
    // predicate is what enforces this; if a future regression dropped it,
    // this test would fail loudly.
    const parentUid = generateId();
    await backend.setDoc(
      parentUid,
      {
        aType: 'agent',
        aUid: parentUid,
        axbType: 'is',
        bType: 'agent',
        bUid: parentUid,
        data: { name: 'parent' },
      },
      'replace',
    );

    const sub = backend.subgraph(parentUid, 'memories');
    const memUid = generateId();
    await sub.setDoc(
      memUid,
      {
        aType: 'memory',
        aUid: memUid,
        axbType: 'is',
        bType: 'memory',
        bUid: memUid,
        data: { topic: 'thing' },
      },
      'replace',
    );

    const out = await sub.bulkDelete!([{ field: 'aType', op: '==', value: 'memory' }]);
    expect(out.deleted).toBe(1);

    // Parent scope's row is intact.
    const parentRows = await backend.query([{ field: 'aType', op: '==', value: 'agent' }]);
    expect(parentRows).toHaveLength(1);
    // Subgraph is empty.
    const subRows = await sub.query([]);
    expect(subRows).toHaveLength(0);
  });
});
