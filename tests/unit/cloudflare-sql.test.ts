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

describe('cloudflare/sql compileDOSet', () => {
  it('produces INSERT OR REPLACE with serialized data', () => {
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
    );
    expect(params[6]).toBe('{}');
    expect(params[7]).toBeNull();
  });
});

describe('cloudflare/sql compileDOUpdate', () => {
  it('emits json_set for shallow field updates', () => {
    const { sql, params } = compileDOUpdate(
      'firegraph',
      'abc',
      { dataFields: { status: 'active' } },
      1,
    );
    expect(sql).toMatch(
      /UPDATE "firegraph" SET "data" = json_set\(COALESCE\("data", '\{\}'\), \?, \?\), "updated_at" = \? WHERE "doc_id" = \?/,
    );
    expect(params).toEqual(['$.status', 'active', 1, 'abc']);
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

  it('rejects dataFields with unsafe keys', () => {
    expect(() => compileDOUpdate('firegraph', 'abc', { dataFields: { 'bad key': 1 } }, 0)).toThrow(
      /not a safe JSON-path identifier/,
    );
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
