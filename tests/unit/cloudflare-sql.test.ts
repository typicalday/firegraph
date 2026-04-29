/**
 * Cloudflare DO SQL compiler unit tests.
 *
 * These tests validate the SQL strings and parameter arrays emitted by
 * `src/cloudflare/sql.ts` without touching SQLite — a regression here would
 * break every DO backend consumer, and the expected output is stable.
 */

import { describe, expect, it } from 'vitest';

import {
  buildDOSchemaStatements,
  DO_FIELD_TO_COLUMN,
  quoteDOIdent,
  validateDOTableName,
} from '../../src/cloudflare/schema.js';
import {
  compileDOAggregate,
  compileDOBulkDelete,
  compileDOBulkUpdate,
  compileDODelete,
  compileDODeleteAll,
  compileDOSelect,
  compileDOSelectByDocId,
  compileDOSet,
  compileDOUpdate,
  hydrateDORecord,
  rowToDORecord,
} from '../../src/cloudflare/sql.js';
import { DEFAULT_CORE_INDEXES } from '../../src/default-indexes.js';
import { flattenPatch } from '../../src/internal/write-plan.js';
import { createRegistry } from '../../src/registry.js';
import type { GraphTimestamp } from '../../src/timestamp.js';
import { GraphTimestampImpl } from '../../src/timestamp.js';
describe('cloudflare/schema', () => {
  it('validates identifiers with the same pattern as SQL identifiers', () => {
    expect(() => validateDOTableName('firegraph')).not.toThrow();
    expect(() => validateDOTableName('my_graph_99')).not.toThrow();
    expect(() => validateDOTableName('_underscore')).not.toThrow();

    expect(() => validateDOTableName('9starts_with_digit')).toThrow();
    expect(() => validateDOTableName('has-hyphen')).toThrow();
    expect(() => validateDOTableName('has space')).toThrow();
    expect(() => validateDOTableName('has"quote')).toThrow();
    expect(() => validateDOTableName('')).toThrow();
  });

  it('quotes identifiers with double quotes', () => {
    expect(quoteDOIdent('firegraph')).toBe('"firegraph"');
    expect(() => quoteDOIdent('drop; table users')).toThrow();
  });

  it('maps firegraph fields to flat columns (no scope)', () => {
    expect(DO_FIELD_TO_COLUMN).toMatchObject({
      aType: 'a_type',
      aUid: 'a_uid',
      axbType: 'axb_type',
      bType: 'b_type',
      bUid: 'b_uid',
    });
    // There must be NO scope column — that's the whole point of the redesign.
    expect(Object.values(DO_FIELD_TO_COLUMN)).not.toContain('scope');
  });

  it('emits CREATE TABLE + indexes with no scope column', () => {
    const stmts = buildDOSchemaStatements('firegraph');
    expect(stmts.length).toBeGreaterThan(1);

    const joined = stmts.join('\n');
    expect(joined).toContain('"firegraph"');
    expect(joined).toContain('doc_id');
    expect(joined).toContain('a_uid');
    expect(joined).toContain('b_uid');
    expect(joined).toContain('axb_type');
    expect(joined).not.toContain('scope'); // critical invariant
  });

  it('defaults to DEFAULT_CORE_INDEXES (1 CREATE TABLE + 8 CREATE INDEX)', () => {
    const stmts = buildDOSchemaStatements('firegraph');
    expect(stmts).toHaveLength(1 + DEFAULT_CORE_INDEXES.length);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
    for (const s of stmts.slice(1)) {
      expect(s).toMatch(/CREATE INDEX IF NOT EXISTS/);
    }
  });

  it('coreIndexes: [] disables the default preset — only CREATE TABLE is emitted', () => {
    const stmts = buildDOSchemaStatements('firegraph', { coreIndexes: [] });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
  });

  it('coreIndexes override replaces the preset entirely', () => {
    const stmts = buildDOSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
    });
    // 1 CREATE TABLE + 1 CREATE INDEX
    expect(stmts).toHaveLength(2);
    // JSON path inlined (not parametrized) so the SQLite planner matches the
    // same expression the query compiler emits.
    expect(stmts[1]).toContain(`json_extract("data", '$.status')`);
    expect(stmts[1]).not.toContain(`json_extract("data", ?)`);
  });

  it('emits composite DDL with ASC/DESC from IndexFieldSpec', () => {
    const stmts = buildDOSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', { path: 'updatedAt', desc: true }] }],
    });
    const ddl = stmts[1];
    expect(ddl).toContain('"a_type"');
    expect(ddl).toMatch(/"updated_at" DESC/);
  });

  it('appends partial-index WHERE clause when `where` is set', () => {
    const stmts = buildDOSchemaStatements('firegraph', {
      coreIndexes: [
        {
          fields: ['aType', 'axbType'],
          where: `json_extract("data", '$.archived') = 0`,
        },
      ],
    });
    const ddl = stmts[1];
    expect(ddl).toMatch(/WHERE json_extract\("data", '\$\.archived'\) = 0$/);
  });

  it('merges RegistryEntry.indexes with the core preset', () => {
    const registry = createRegistry([
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
      },
    ]);
    const stmts = buildDOSchemaStatements('firegraph', { registry });
    // 1 CREATE TABLE + 8 preset + 1 registry = 10
    expect(stmts).toHaveLength(10);
    const registryDDL = stmts.find((s) => s.includes(`'$.status'`));
    expect(registryDDL).toBeDefined();
  });

  it('dedupes identical specs across core preset and registry entries', () => {
    const registry = createRegistry([
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        // This duplicates a DEFAULT_CORE_INDEXES composite — the fingerprint
        // matches, so only one CREATE INDEX emits.
        indexes: [{ fields: ['aType', 'axbType'] }],
      },
    ]);
    const stmts = buildDOSchemaStatements('firegraph', { registry });
    // 1 CREATE TABLE + 8 preset (no extra from registry)
    expect(stmts).toHaveLength(9);
  });

  it('emits deterministic index names (same spec across runs produces same DDL)', () => {
    const a = buildDOSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'data.status'] }],
    });
    const b = buildDOSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'data.status'] }],
    });
    expect(a).toEqual(b);
    // The name is `firegraph_idx_{hash}` with a stable 8-char hex hash.
    expect(a[1]).toMatch(/CREATE INDEX IF NOT EXISTS "firegraph_idx_[0-9a-f]{8}"/);
  });

  it('rejects invalid JSON path components in data.* specs', () => {
    expect(() =>
      buildDOSchemaStatements('firegraph', {
        coreIndexes: [{ fields: ['aType', 'data.bad key'] }],
      }),
    ).toThrow(/invalid component/);
  });

  it('emits IF NOT EXISTS on every index so bootstrap is idempotent', () => {
    const stmts = buildDOSchemaStatements('firegraph');
    for (const s of stmts.slice(1)) {
      expect(s).toContain('CREATE INDEX IF NOT EXISTS');
    }
  });
});

describe('cloudflare/sql compileDOSelect', () => {
  it('emits SELECT * without scope predicate for an unfiltered query', () => {
    const { sql, params } = compileDOSelect('firegraph', []);
    expect(sql).toBe('SELECT * FROM "firegraph"');
    expect(params).toEqual([]);
  });

  it('compiles a simple equality filter', () => {
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'aUid', op: '==', value: 'abc' },
    ]);
    expect(sql).toBe('SELECT * FROM "firegraph" WHERE "a_uid" = ?');
    expect(params).toEqual(['abc']);
  });

  it('compiles `data.*` filters via json_extract with an inlined JSON path', () => {
    // The JSON path literal is inlined (not parametrized) so SQLite's query
    // planner matches the expression index emitted by `sqlite-index-ddl.ts`
    // — a parametrized `json_extract("data", ?)` would never hit the index.
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'data.status', op: '==', value: 'active' },
    ]);
    expect(sql).toBe(`SELECT * FROM "firegraph" WHERE json_extract("data", '$.status') = ?`);
    expect(params).toEqual(['active']);
  });

  it('inlines nested JSON paths too', () => {
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'data.author.name', op: '==', value: 'alex' },
    ]);
    expect(sql).toBe(`SELECT * FROM "firegraph" WHERE json_extract("data", '$.author.name') = ?`);
    expect(params).toEqual(['alex']);
  });

  it('compiles bare `data` as json_extract on $', () => {
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'data', op: '==', value: '{}' },
    ]);
    expect(sql).toBe(`SELECT * FROM "firegraph" WHERE json_extract("data", '$') = ?`);
    expect(params).toEqual(['{}']);
  });

  it('rejects `data.<unsafe-key>` paths at compile time', () => {
    expect(() =>
      compileDOSelect('firegraph', [{ field: 'data.weird key', op: '==', value: 1 }]),
    ).toThrow(/not a safe JSON-path identifier/);
  });

  it('supports in / not-in with multiple placeholders', () => {
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'aType', op: 'in', value: ['a', 'b', 'c'] },
    ]);
    expect(sql).toBe('SELECT * FROM "firegraph" WHERE "a_type" IN (?, ?, ?)');
    expect(params).toEqual(['a', 'b', 'c']);
  });

  it('emits array-contains via EXISTS + json_each with inlined JSON path', () => {
    const { sql, params } = compileDOSelect('firegraph', [
      { field: 'data.tags', op: 'array-contains', value: 'x' },
    ]);
    expect(sql).toContain(
      `EXISTS (SELECT 1 FROM json_each(json_extract("data", '$.tags')) WHERE value = ?)`,
    );
    expect(params).toEqual(['x']);
  });

  it('appends ORDER BY and LIMIT', () => {
    const { sql, params } = compileDOSelect(
      'firegraph',
      [{ field: 'aUid', op: '==', value: 'x' }],
      { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 10 },
    );
    expect(sql).toBe(
      'SELECT * FROM "firegraph" WHERE "a_uid" = ? ORDER BY "created_at" DESC LIMIT ?',
    );
    expect(params).toEqual(['x', 10]);
  });
});

describe('cloudflare/sql compileDOSelectByDocId', () => {
  it('produces an O(1) primary-key lookup', () => {
    const { sql, params } = compileDOSelectByDocId('firegraph', '0:abc:is:abc');
    expect(sql).toBe('SELECT * FROM "firegraph" WHERE "doc_id" = ? LIMIT 1');
    expect(params).toEqual(['0:abc:is:abc']);
  });
});

describe('cloudflare/sql compileDOAggregate', () => {
  // The DO compiler does NOT emit a `scope` predicate — every row in a
  // FiregraphDO's SQLite belongs to the same subgraph. That contrast with
  // the shared-table compiler (which always leads with `"scope" = ?`) is
  // the core invariant to defend.

  it('emits COUNT(*) with no WHERE clause when no filters are supplied', () => {
    const { stmt, aliases } = compileDOAggregate('firegraph', { total: { op: 'count' } }, []);
    expect(stmt.sql).toBe('SELECT COUNT(*) AS "total" FROM "firegraph"');
    expect(stmt.params).toEqual([]);
    expect(aliases).toEqual(['total']);
  });

  it('appends WHERE for filters but never a scope predicate', () => {
    const { stmt, aliases } = compileDOAggregate('firegraph', { n: { op: 'count' } }, [
      { field: 'aType', op: '==', value: 'tour' },
    ]);
    expect(stmt.sql).toBe('SELECT COUNT(*) AS "n" FROM "firegraph" WHERE "a_type" = ?');
    expect(stmt.params).toEqual(['tour']);
    // Critical invariant — leading "scope" predicate is shared-table-only.
    expect(stmt.sql).not.toContain('"scope"');
    expect(aliases).toEqual(['n']);
  });

  it('compiles SUM/AVG/MIN/MAX with CAST(... AS REAL) for numeric semantics', () => {
    // Without the cast, MIN/MAX would compare lexicographically on the
    // underlying JSON text storage ("100" < "20"). The cast forces numeric
    // semantics on all four ops; COUNT is unaffected.
    const { stmt } = compileDOAggregate(
      'firegraph',
      {
        s: { op: 'sum', field: 'data.price' },
        a: { op: 'avg', field: 'data.price' },
        lo: { op: 'min', field: 'data.price' },
        hi: { op: 'max', field: 'data.price' },
      },
      [],
    );
    expect(stmt.sql).toContain(`SUM(CAST(json_extract("data", '$.price') AS REAL)) AS "s"`);
    expect(stmt.sql).toContain(`AVG(CAST(json_extract("data", '$.price') AS REAL)) AS "a"`);
    expect(stmt.sql).toContain(`MIN(CAST(json_extract("data", '$.price') AS REAL)) AS "lo"`);
    expect(stmt.sql).toContain(`MAX(CAST(json_extract("data", '$.price') AS REAL)) AS "hi"`);
  });

  it('inlines JSON paths in field references (matches expression-index form)', () => {
    // The aggregate path must reuse the same `compileFieldRef` rules as the
    // SELECT path so that `CREATE INDEX … ON tbl(json_extract("data", '$.x'))`
    // can match the aggregate expression. Parametrising the path would
    // silently fall back to a full scan.
    const { stmt } = compileDOAggregate('firegraph', { s: { op: 'sum', field: 'data.price' } }, []);
    expect(stmt.sql).toContain(`json_extract("data", '$.price')`);
    expect(stmt.sql).not.toContain(`json_extract("data", ?)`);
  });

  it('rejects aliases that fail the JSON-path identifier rule', () => {
    // Aliases are inlined into SQL (SQL aliases can't be bound parameters),
    // so they must pass the same charset rule used everywhere else. This is
    // the SQL-injection defense.
    expect(() => compileDOAggregate('firegraph', { 'bad alias': { op: 'count' } }, [])).toThrow(
      /not a safe JSON-path identifier/,
    );
    expect(() =>
      compileDOAggregate('firegraph', { 'a"; DROP TABLE x;--': { op: 'count' } }, []),
    ).toThrow(/not a safe JSON-path identifier/);
  });

  it('rejects non-count ops without a field', () => {
    expect(() => compileDOAggregate('firegraph', { s: { op: 'sum' } }, [])).toThrow(
      /'sum' requires a field/,
    );
    expect(() => compileDOAggregate('firegraph', { a: { op: 'avg' } }, [])).toThrow(
      /'avg' requires a field/,
    );
    expect(() => compileDOAggregate('firegraph', { lo: { op: 'min' } }, [])).toThrow(
      /'min' requires a field/,
    );
  });

  it('rejects an empty spec', () => {
    expect(() => compileDOAggregate('firegraph', {}, [])).toThrow(/at least one aggregation/);
  });

  it('rejects count with a stray field (catches typo from cribbing a sum spec)', () => {
    // The count op operates on rows, not a column expression. Silently
    // ignoring a stray field would mask user typos like
    // `{ n: { op: 'count', field: 'data.price' } }` (cribbed from a sum
    // spec) and produce a misleading row count.
    expect(() =>
      compileDOAggregate('firegraph', { n: { op: 'count', field: 'data.price' } }, []),
    ).toThrow(/'count' must not specify a field/);
  });

  it('preserves alias order in the returned aliases list', () => {
    // Spec keys are in iteration order; the alias array must mirror that so
    // the JS-side caller can rehydrate result columns deterministically.
    const { aliases } = compileDOAggregate(
      'firegraph',
      {
        zCount: { op: 'count' },
        aSum: { op: 'sum', field: 'data.x' },
        mAvg: { op: 'avg', field: 'data.x' },
      },
      [],
    );
    expect(aliases).toEqual(['zCount', 'aSum', 'mAvg']);
  });

  it('combines a built-in column filter with a data.* JSON filter', () => {
    const { stmt } = compileDOAggregate('firegraph', { n: { op: 'count' } }, [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '==', value: 'active' },
    ]);
    expect(stmt.sql).toBe(
      `SELECT COUNT(*) AS "n" FROM "firegraph" WHERE "a_type" = ? AND json_extract("data", '$.status') = ?`,
    );
    expect(stmt.params).toEqual(['tour', 'active']);
  });
});

describe('cloudflare/sql compileDOSet', () => {
  it('produces INSERT OR REPLACE with serialized data when mode = replace', () => {
    const { sql, params } = compileDOSet(
      'firegraph',
      'abc',
      {
        aType: 'tour',
        aUid: 'abc',
        axbType: 'is',
        bType: 'tour',
        bUid: 'abc',
        data: { title: 'Everest' },
        v: 1,
      },
      1_700_000_000_000,
      'replace',
    );
    expect(sql).toContain('INSERT OR REPLACE INTO "firegraph"');
    expect(params).toEqual([
      'abc',
      'tour',
      'abc',
      'is',
      'tour',
      'abc',
      JSON.stringify({ title: 'Everest' }),
      1,
      1_700_000_000_000,
      1_700_000_000_000,
    ]);
  });

  it('defaults empty data to `{}` and v to null', () => {
    const { params } = compileDOSet(
      'firegraph',
      'abc',
      { aType: 't', aUid: 'a', axbType: 'is', bType: 't', bUid: 'a', data: {} },
      0,
      'replace',
    );
    expect(params[6]).toBe('{}');
    expect(params[7]).toBeNull();
  });

  it('emits INSERT … ON CONFLICT DO UPDATE when mode = merge', () => {
    const { sql } = compileDOSet(
      'firegraph',
      'abc',
      {
        aType: 'tour',
        aUid: 'abc',
        axbType: 'is',
        bType: 'tour',
        bUid: 'abc',
        data: { title: 'Everest' },
      },
      1_700_000_000_000,
      'merge',
    );
    expect(sql).toContain('ON CONFLICT(doc_id) DO UPDATE SET');
    expect(sql).toContain('"data" = json_set(');
  });

  it('uses COALESCE on `v` so a merge-put without `v` preserves the stored version', () => {
    // Cross-backend parity with Firestore: stampWritableRecord omits `v`
    // when undefined, and Firestore's `set(record, {merge: true})` then
    // leaves the stored `v` intact. SQLite/DO must match — the COALESCE
    // is what guarantees this. A plain `excluded.v` assignment would
    // clobber the stored `v` to NULL on every put-without-migrations and
    // silently break migration replay if migrations are removed and
    // later re-added.
    const { sql } = compileDOSet(
      'firegraph',
      'abc',
      {
        aType: 'tour',
        aUid: 'abc',
        axbType: 'is',
        bType: 'tour',
        bUid: 'abc',
        data: { title: 'Everest' },
      },
      1_700_000_000_000,
      'merge',
    );
    expect(sql).toContain(`"v" = COALESCE(excluded."v", "v")`);
  });
});

describe('cloudflare/sql compileDOUpdate', () => {
  it('emits json_set for shallow field updates', () => {
    const { sql, params } = compileDOUpdate(
      'firegraph',
      'abc',
      { dataOps: flattenPatch({ status: 'active' }) },
      1,
    );
    expect(sql).toMatch(
      /UPDATE "firegraph" SET "data" = json_set\(COALESCE\("data", '\{\}'\), \?, json\(\?\)\), "updated_at" = \? WHERE "doc_id" = \?/,
    );
    expect(params).toEqual(['$.status', JSON.stringify('active'), 1, 'abc']);
  });

  it('emits a straight data = ? for replaceData', () => {
    const { sql, params } = compileDOUpdate(
      'firegraph',
      'abc',
      { replaceData: { status: 'active' } },
      1,
    );
    expect(sql).toMatch(
      /UPDATE "firegraph" SET "data" = \?, "updated_at" = \? WHERE "doc_id" = \?/,
    );
    expect(params).toEqual([JSON.stringify({ status: 'active' }), 1, 'abc']);
  });

  it('stamps v when provided', () => {
    const { sql, params } = compileDOUpdate('firegraph', 'abc', { v: 3 }, 1);
    expect(sql).toContain('"v" = ?');
    expect(params).toEqual([3, 1, 'abc']);
  });

  it('rejects unsafe keys in deep dataOps paths', () => {
    expect(() =>
      compileDOUpdate('firegraph', 'abc', { dataOps: flattenPatch({ 'bad key': 1 }) }, 0),
    ).toThrow(/safe JSON-path identifier|safe object key/);
  });
});

describe('cloudflare/sql compileDODelete', () => {
  it('emits a single-row delete by doc_id', () => {
    const { sql, params } = compileDODelete('firegraph', 'abc');
    expect(sql).toBe('DELETE FROM "firegraph" WHERE "doc_id" = ?');
    expect(params).toEqual(['abc']);
  });
});

describe('cloudflare/sql compileDODeleteAll', () => {
  it('emits an unconditional delete (used by `_fgDestroy`)', () => {
    const { sql, params } = compileDODeleteAll('firegraph');
    expect(sql).toBe('DELETE FROM "firegraph"');
    expect(params).toEqual([]);
  });
});

describe('cloudflare/sql rowToDORecord — wire format (DO side)', () => {
  it('parses JSON data and emits timestamps as plain millis', () => {
    const wire = rowToDORecord({
      doc_id: 'abc',
      a_type: 'tour',
      a_uid: 'abc',
      axb_type: 'is',
      b_type: 'tour',
      b_uid: 'abc',
      data: JSON.stringify({ title: 'Everest' }),
      v: 2,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
    });
    expect(wire.aUid).toBe('abc');
    expect(wire.data).toEqual({ title: 'Everest' });
    expect(wire.v).toBe(2);
    // Wire shape uses plain numbers so structured clone across DO RPC
    // doesn't drop prototype-bound methods.
    expect(wire.createdAtMs).toBe(1_700_000_000_000);
    expect(wire.updatedAtMs).toBe(1_700_000_001_000);
  });

  it('drops v when null', () => {
    const wire = rowToDORecord({
      doc_id: 'abc',
      a_type: 'tour',
      a_uid: 'abc',
      axb_type: 'is',
      b_type: 'tour',
      b_uid: 'abc',
      data: null,
      v: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(wire.v).toBeUndefined();
    expect(wire.data).toEqual({});
  });
});

describe('cloudflare/sql hydrateDORecord — client-side reconstruction', () => {
  it('wraps wire millis as GraphTimestampImpl instances', () => {
    const rec = hydrateDORecord({
      aType: 'tour',
      aUid: 'abc',
      axbType: 'is',
      bType: 'tour',
      bUid: 'abc',
      data: { title: 'Everest' },
      v: 2,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_001_000,
    });
    expect(rec.aUid).toBe('abc');
    expect(rec.data).toEqual({ title: 'Everest' });
    expect(rec.v).toBe(2);
    expect(rec.createdAt).toBeInstanceOf(GraphTimestampImpl);
    expect(rec.updatedAt).toBeInstanceOf(GraphTimestampImpl);
    expect((rec.createdAt as GraphTimestamp).toMillis()).toBe(1_700_000_000_000);
  });

  it('survives a structured-clone round-trip (simulates DO RPC boundary)', () => {
    const wire = rowToDORecord({
      doc_id: 'abc',
      a_type: 'tour',
      a_uid: 'abc',
      axb_type: 'is',
      b_type: 'tour',
      b_uid: 'abc',
      data: JSON.stringify({ title: 'Everest' }),
      v: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
    });
    // Node's structuredClone emulates the DO RPC boundary. If the DO returned
    // a `GraphTimestampImpl` directly it would survive this call as a plain
    // object, losing `toMillis()`. With the wire format, everything lives.
    const cloned = structuredClone(wire);
    const rec = hydrateDORecord(cloned);
    expect(rec.createdAt).toBeInstanceOf(GraphTimestampImpl);
    expect((rec.createdAt as GraphTimestamp).toMillis()).toBe(1_700_000_000_000);
  });
});

describe('cloudflare/sql compileDOBulkDelete', () => {
  // Per-DO single-subgraph table — no scope predicate is needed (and would
  // be wrong, since the DO is the scope). Mirror of compileBulkDelete in
  // shared SQLite, minus the leading "scope" = ?.

  it('emits an unscoped DELETE for a filtered query', () => {
    const stmt = compileDOBulkDelete('firegraph', [{ field: 'aType', op: '==', value: 'tour' }]);
    expect(stmt.sql).toBe(`DELETE FROM "firegraph" WHERE "a_type" = ?`);
    expect(stmt.params).toEqual(['tour']);
  });

  it('emits an unconditional DELETE when no filters are supplied', () => {
    // The client-level scan-protection gate forces `allowCollectionScan: true`
    // to reach this path. The compiler itself does not police that — it
    // produces the canonical SQL. The DO's per-subgraph isolation means
    // "delete everything" is bounded to one logical subgraph by construction.
    const stmt = compileDOBulkDelete('firegraph', []);
    expect(stmt.sql).toBe(`DELETE FROM "firegraph"`);
    expect(stmt.params).toEqual([]);
  });

  it('combines a built-in column filter with a data.* JSON filter', () => {
    const stmt = compileDOBulkDelete('firegraph', [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '==', value: 'archived' },
    ]);
    expect(stmt.sql).toContain(`"a_type" = ?`);
    expect(stmt.sql).toContain(`json_extract("data", '$.status') = ?`);
    expect(stmt.params).toEqual(['tour', 'archived']);
  });
});

describe('cloudflare/sql compileDOBulkUpdate', () => {
  it('emits SET "data" = json_patch-style expr and an updated_at bump', () => {
    const stmt = compileDOBulkUpdate(
      'firegraph',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { status: 'archived' },
      1_700_000_000_000,
    );
    // Deep-merge expression.
    expect(stmt.sql).toMatch(/UPDATE\s+"firegraph"\s+SET\s+"data"\s*=/);
    // updated_at always bumped.
    expect(stmt.sql).toContain(`"updated_at" = ?`);
    // No scope predicate — DO has its own physical isolation.
    expect(stmt.sql).not.toContain(`"scope" = ?`);
    // WHERE clause references the column-filter, not the JSON path.
    expect(stmt.sql).toContain(`"a_type" = ?`);
    // updated_at param appears in the param list.
    expect(stmt.params).toContain(1_700_000_000_000);
    // Last param is the filter value (after SET-clause params).
    expect(stmt.params[stmt.params.length - 1]).toBe('tour');
  });

  it('rejects an empty patch with INVALID_QUERY', () => {
    expect(() => compileDOBulkUpdate('firegraph', [], {}, Date.now())).toThrow(
      /at least one leaf|INVALID_QUERY/,
    );
  });

  it('emits an unconditional UPDATE when no filters are supplied (with allowCollectionScan)', () => {
    // Same client-level gate as bulkDelete. Once filters reach the
    // compiler, an empty list produces an UPDATE-everything-in-the-DO SQL.
    const stmt = compileDOBulkUpdate('firegraph', [], { archived: true }, 1_700_000_000_000);
    // No WHERE clause when there are no filters.
    expect(stmt.sql).not.toContain(' WHERE ');
    // updated_at and the patched data still flow through.
    expect(stmt.sql).toContain(`"updated_at" = ?`);
    expect(stmt.sql).toMatch(/SET\s+"data"\s*=/);
  });

  it('rejects Firestore special types in the patch', () => {
    // assertJsonSafePayload guard — DOs use SQLite JSON columns; tagged
    // Firestore types would round-trip back through the migration
    // serialization but never write. Rejected at the DML boundary.
    const tagged = { __firegraph_ser__: 'Timestamp', seconds: 1, nanoseconds: 0 };
    expect(() => compileDOBulkUpdate('firegraph', [], { stamped: tagged }, Date.now())).toThrow();
  });
});

describe('cloudflare/sql compileDOExpand / compileDOExpandHydrate', () => {
  // Phase 6 query.join: per-DO multi-source fan-out via SQL `IN (?, ?, …)`.
  // Mirror of compileExpand / compileExpandHydrate in shared SQLite, minus
  // the leading "scope" = ? predicate (the DO is the scope).

  it('compileDOExpand emits IN (?, ?, …) with leading axbType, no scope predicate', async () => {
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpand('firegraph', {
      sources: ['a', 'b', 'c'],
      axbType: 'wrote',
    });
    // Column refs use snake_case (`a_uid`, `axb_type`, `b_uid`) — see
    // `DO_FIELD_TO_COLUMN` in `src/cloudflare/schema.ts`.
    expect(stmt.sql).toContain(`SELECT * FROM "firegraph"`);
    expect(stmt.sql).not.toContain('"scope" = ?');
    expect(stmt.sql).toContain('"axb_type" = ?');
    expect(stmt.sql).toContain('"a_uid" IN (?, ?, ?)');
    // Param order: axbType, then each source UID in order.
    expect(stmt.params).toEqual(['wrote', 'a', 'b', 'c']);
  });

  it('compileDOExpand reverse direction filters on bUid', async () => {
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpand('firegraph', {
      sources: ['x', 'y'],
      axbType: 'wrote',
      direction: 'reverse',
    });
    expect(stmt.sql).toContain('"b_uid" IN (?, ?)');
    expect(stmt.sql).not.toContain('"a_uid" IN (');
  });

  it('compileDOExpand with axbType "is" adds the self-loop guard', async () => {
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpand('firegraph', {
      sources: ['a'],
      axbType: 'is',
    });
    expect(stmt.sql).toContain('"a_uid" != "b_uid"');
  });

  it('compileDOExpand emits a_type / b_type predicates with snake_case columns', async () => {
    // Audit gap: the leading-shape test doesn't exercise the optional
    // `aType` / `bType` refinements. Compiler resolves them through
    // `compileFieldRef`, which routes camelCase field names → snake_case
    // columns via `DO_FIELD_TO_COLUMN`. A regression that emitted
    // `"aType" = ?` would crash workerd's SQLite with "no such column".
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpand('firegraph', {
      sources: ['a', 'b'],
      axbType: 'wrote',
      aType: 'agent',
      bType: 'note',
    });
    expect(stmt.sql).toContain('"a_type" = ?');
    expect(stmt.sql).toContain('"b_type" = ?');
    expect(stmt.sql).not.toContain('"aType"');
    expect(stmt.sql).not.toContain('"bType"');
    // Param ordering: axbType, sources..., aType, bType.
    expect(stmt.params).toEqual(['wrote', 'a', 'b', 'agent', 'note']);
  });

  it('compileDOExpand multiplies limitPerSource by sources.length', async () => {
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpand('firegraph', {
      sources: ['a', 'b'],
      axbType: 'wrote',
      limitPerSource: 7,
    });
    expect(stmt.sql).toMatch(/LIMIT \?/);
    expect(stmt.params[stmt.params.length - 1]).toBe(14);
  });

  it('compileDOExpand rejects empty sources list', async () => {
    const { compileDOExpand } = await import('../../src/cloudflare/sql.js');
    expect(() => compileDOExpand('firegraph', { sources: [], axbType: 'wrote' })).toThrow(
      /INVALID_QUERY|empty/,
    );
  });

  it('compileDOExpandHydrate emits the self-loop predicate without a scope clause', async () => {
    const { compileDOExpandHydrate } = await import('../../src/cloudflare/sql.js');
    const stmt = compileDOExpandHydrate('firegraph', ['x', 'y']);
    expect(stmt.sql).not.toContain('"scope" = ?');
    expect(stmt.sql).toContain('"axb_type" = ?');
    expect(stmt.sql).toContain('"a_uid" = "b_uid"');
    expect(stmt.sql).toContain('"b_uid" IN (?, ?)');
    // Param order: axbType ('is'), then each target UID.
    expect(stmt.params).toEqual(['is', 'x', 'y']);
  });

  it('compileDOExpandHydrate rejects empty target list', async () => {
    const { compileDOExpandHydrate } = await import('../../src/cloudflare/sql.js');
    expect(() => compileDOExpandHydrate('firegraph', [])).toThrow(/INVALID_QUERY|empty/);
  });
});
