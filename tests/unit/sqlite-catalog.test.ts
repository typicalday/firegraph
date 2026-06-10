/**
 * Unit tests for the table-per-graph catalog helpers (`src/sqlite/catalog.ts`).
 *
 * The catalog maps storage scopes (interleaved `parentUid/name` paths) to
 * physical table names. Two properties carry the whole design:
 *   1. `mangleStorageScope` is injective — two distinct scopes can never
 *      land on the same table.
 *   2. `escapeLikePrefix` neutralises LIKE wildcards — cascade prefix
 *      matching can never leak across sibling scopes whose names contain
 *      `%` or `_` (the nanoid alphabet includes `_`).
 */
import { describe, expect, it } from 'vitest';

import {
  buildCatalogDDL,
  catalogTableName,
  compileCatalogDelete,
  compileCatalogDescendants,
  compileCatalogRegister,
  escapeLikePrefix,
  mangleStorageScope,
  tableForScope,
} from '../../src/sqlite/catalog.js';

describe('catalogTableName', () => {
  it('derives <root>_graphs', () => {
    expect(catalogTableName('firegraph')).toBe('firegraph_graphs');
  });

  it('validates the root table name', () => {
    expect(() => catalogTableName('1bad')).toThrow(/Invalid SQL identifier/);
    expect(() => catalogTableName('a-b')).toThrow(/Invalid SQL identifier/);
  });
});

describe('mangleStorageScope', () => {
  it('passes alphanumerics through unchanged', () => {
    expect(mangleStorageScope('Abc123')).toBe('Abc123');
  });

  it('escapes the escape character itself by doubling', () => {
    expect(mangleStorageScope('a_b')).toBe('a__b');
  });

  it('maps nanoid hyphen and scope separator to distinct sequences', () => {
    expect(mangleStorageScope('a-b')).toBe('a_hb');
    expect(mangleStorageScope('a/b')).toBe('a_sb');
  });

  it('hex-escapes everything else', () => {
    expect(mangleStorageScope('a.b')).toBe('a_u2e_b');
    expect(mangleStorageScope('aéb')).toBe('a_ue9_b');
    // Astral-plane codepoint (emoji) — `for...of` iterates codepoints, not
    // UTF-16 units, so the escape covers the full character.
    expect(mangleStorageScope('a😀b')).toBe('a_u1f600_b');
  });

  it('produces SQL-identifier-safe output', () => {
    const scopes = ['uid1/memories', 'a-b_c/d.e', 'X9/foo%bar', 'p/q/r'];
    for (const scope of scopes) {
      expect(mangleStorageScope(scope)).toMatch(/^[A-Za-z0-9_]*$/);
    }
  });

  it('is injective across adversarially-similar scopes', () => {
    // Pairs engineered to collide under naive mangling (e.g. mapping both
    // `-` and `/` to `_`, or not escaping literal `_`).
    const scopes = [
      'a_hb', // literal text that looks like the mangling of 'a-b'
      'a-b',
      'a_sb', // literal text that looks like the mangling of 'a/b'
      'a/b',
      'a__b', // literal text that looks like the mangling of 'a_b'
      'a_b',
      'a_u2e_b', // literal text that looks like the mangling of 'a.b'
      'a.b',
      'ab',
      'a/b/c',
      'a/bc',
      'ab/c',
      'a-b/c',
      'a/b-c',
    ];
    const mangled = scopes.map(mangleStorageScope);
    expect(new Set(mangled).size).toBe(scopes.length);
  });
});

describe('tableForScope', () => {
  it('returns the root table for the empty scope', () => {
    expect(tableForScope('firegraph', '')).toBe('firegraph');
  });

  it('derives <root>_g_<mangled> for subgraph scopes', () => {
    expect(tableForScope('firegraph', 'uid1/memories')).toBe('firegraph_g_uid1_smemories');
  });

  it('never collides with the catalog table', () => {
    // `_graphs` cannot be produced: subgraph tables always carry the `_g_`
    // infix followed by the mangled scope, and `mangleStorageScope('')` only
    // arises for the root which returns early.
    expect(tableForScope('t', 'raphs')).toBe('t_g_raphs');
    expect(catalogTableName('t')).toBe('t_graphs');
    expect(tableForScope('t', 'raphs')).not.toBe(catalogTableName('t'));
  });

  it('distinct scopes map to distinct tables', () => {
    const a = tableForScope('t', 'uid1/memories');
    const b = tableForScope('t', 'uid2/memories');
    const c = tableForScope('t', 'uid1/memories/uid2/context');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('validates the root table name', () => {
    expect(() => tableForScope('a b', 'x/y')).toThrow(/Invalid SQL identifier/);
  });
});

describe('escapeLikePrefix', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLikePrefix('a%b')).toBe('a\\%b');
    expect(escapeLikePrefix('a_b')).toBe('a\\_b');
    expect(escapeLikePrefix('a\\b')).toBe('a\\\\b');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLikePrefix('uid1/memories')).toBe('uid1/memories');
  });
});

describe('compiled catalog statements', () => {
  it('register is idempotent (INSERT OR IGNORE) with scope/table/path params', () => {
    const stmt = compileCatalogRegister('t', 'uid/mem', 't_g_uid_smem', 'mem');
    expect(stmt.sql).toContain('INSERT OR IGNORE INTO "t_graphs"');
    expect(stmt.params).toEqual(['uid/mem', 't_g_uid_smem', 'mem']);
  });

  it('descendants uses an escaped LIKE prefix with ESCAPE clause', () => {
    const stmt = compileCatalogDescendants('t', 'uid_1/foo%bar');
    expect(stmt.sql).toContain(`LIKE ? ESCAPE '\\'`);
    // Wildcards in the prefix are escaped; the trailing /% is the only live
    // wildcard.
    expect(stmt.params).toEqual(['uid\\_1/foo\\%bar/%']);
  });

  it('delete targets a single storage scope', () => {
    const stmt = compileCatalogDelete('t', 'uid/mem');
    expect(stmt.sql).toBe('DELETE FROM "t_graphs" WHERE storage_scope = ?');
    expect(stmt.params).toEqual(['uid/mem']);
  });

  it('DDL declares storage_scope PK and unique table_name', () => {
    const ddl = buildCatalogDDL('t');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "t_graphs"');
    expect(ddl).toMatch(/storage_scope\s+TEXT NOT NULL PRIMARY KEY/);
    expect(ddl).toMatch(/table_name\s+TEXT NOT NULL UNIQUE/);
    expect(ddl).toMatch(/scope_path\s+TEXT NOT NULL/);
  });
});
