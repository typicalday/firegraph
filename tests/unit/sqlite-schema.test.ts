/**
 * Scope-free SQLite schema unit tests.
 *
 * The table-per-graph SQLite editions (better-sqlite3 / D1 in `src/sqlite/`
 * and the Cloudflare DO edition) share one row shape: `doc_id` is the
 * primary key and there is NO `scope` column — each graph's rows live in
 * their own physical table (or their own Durable Object), so isolation is
 * physical rather than a per-row predicate.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_CORE_INDEXES } from '../../src/default-indexes.js';
import {
  buildSchemaStatements,
  FIELD_TO_COLUMN,
  quoteIdent,
  validateTableName,
} from '../../src/internal/sqlite-schema.js';
import { createRegistry } from '../../src/registry.js';

describe('sqlite-schema — identifiers', () => {
  it('validates identifiers', () => {
    expect(() => validateTableName('firegraph')).not.toThrow();
    expect(() => validateTableName('_my_table_2')).not.toThrow();
    expect(() => validateTableName('9bad')).toThrow();
    expect(() => validateTableName('has-hyphen')).toThrow();
    expect(() => validateTableName('has space')).toThrow();
    expect(() => validateTableName('')).toThrow();
  });

  it('quotes identifiers with double quotes', () => {
    expect(quoteIdent('firegraph')).toBe('"firegraph"');
    expect(() => quoteIdent('drop; table users')).toThrow();
  });

  it('maps firegraph fields to columns (no scope mapping)', () => {
    expect(FIELD_TO_COLUMN).toMatchObject({
      aType: 'a_type',
      aUid: 'a_uid',
      axbType: 'axb_type',
      bType: 'b_type',
      bUid: 'b_uid',
    });
    expect(FIELD_TO_COLUMN).not.toHaveProperty('scope');
  });
});

describe('sqlite-schema — buildSchemaStatements defaults', () => {
  it('emits CREATE TABLE with doc_id as the sole primary key and no scope column', () => {
    const stmts = buildSchemaStatements('firegraph');
    const tableDDL = stmts[0];
    expect(tableDDL).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
    expect(tableDDL).toMatch(/doc_id\s+TEXT NOT NULL PRIMARY KEY/);
    expect(tableDDL).not.toContain('scope');
  });

  it('does not emit a secondary doc_id index (the PK covers doc lookups)', () => {
    const stmts = buildSchemaStatements('firegraph');
    expect(stmts.find((s) => s.includes('_idx_doc_id'))).toBeUndefined();
  });

  it('defaults to exactly the core preset indexes', () => {
    const stmts = buildSchemaStatements('firegraph');
    // 1 CREATE TABLE + 8 core preset indexes = 9
    expect(stmts).toHaveLength(1 + DEFAULT_CORE_INDEXES.length);
  });

  it('no index references a scope column', () => {
    const stmts = buildSchemaStatements('firegraph');
    for (const ddl of stmts) {
      expect(ddl).not.toContain('"scope"');
    }
  });
});

describe('sqlite-schema — coreIndexes override', () => {
  it('coreIndexes: [] disables the preset (CREATE TABLE only)', () => {
    const stmts = buildSchemaStatements('firegraph', { coreIndexes: [] });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
  });

  it('coreIndexes override replaces the preset', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
    });
    // CREATE TABLE + 1 core = 2
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toContain(`json_extract("data", '$.status')`);
    expect(stmts[1]).toMatch(/\("a_type", "axb_type"/);
  });

  it('inlines nested JSON paths in expression indexes', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'data.author.name'] }],
    });
    expect(stmts[1]).toContain(`json_extract("data", '$.author.name')`);
  });

  it('emits ASC/DESC order from IndexFieldSpec', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', { path: 'updatedAt', desc: true }] }],
    });
    expect(stmts[1]).toMatch(/"updated_at" DESC/);
  });

  it('appends partial-index WHERE clause', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [
        {
          fields: ['aType', 'axbType'],
          where: `json_extract("data", '$.archived') = 0`,
        },
      ],
    });
    expect(stmts[1]).toMatch(/WHERE json_extract\("data", '\$\.archived'\) = 0$/);
  });
});

describe('sqlite-schema — registry entries', () => {
  it('merges RegistryEntry.indexes with the core preset', () => {
    const registry = createRegistry([
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
      },
    ]);
    const stmts = buildSchemaStatements('firegraph', { registry });
    // CREATE TABLE + 8 preset + 1 registry = 10
    expect(stmts).toHaveLength(1 + DEFAULT_CORE_INDEXES.length + 1);
    const registryDDL = stmts.find((s) => s.includes(`'$.status'`));
    expect(registryDDL).toBeDefined();
    expect(registryDDL!).toMatch(/\("a_type", "axb_type", json_extract/);
  });

  it('dedupes registry specs that duplicate core preset composites', () => {
    const registry = createRegistry([
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['aType', 'axbType'] }],
      },
    ]);
    const stmts = buildSchemaStatements('firegraph', { registry });
    // CREATE TABLE + 8 preset (no extra from registry) = 9
    expect(stmts).toHaveLength(1 + DEFAULT_CORE_INDEXES.length);
  });

  it('produces deterministic index names across runs', () => {
    const registry = createRegistry([
      {
        aType: 't',
        axbType: 'is',
        bType: 't',
        indexes: [{ fields: ['aType', 'data.status'] }],
      },
    ]);
    const a = buildSchemaStatements('firegraph', { registry });
    const b = buildSchemaStatements('firegraph', { registry });
    expect(a).toEqual(b);
  });
});

describe('sqlite-schema — invalid identifiers', () => {
  it('rejects data.* specs with unsafe path components', () => {
    expect(() =>
      buildSchemaStatements('firegraph', {
        coreIndexes: [{ fields: ['aType', 'data.bad key'] }],
      }),
    ).toThrow(/invalid component/);
  });

  it('rejects unknown top-level fields', () => {
    // Neither a firegraph field nor a `data.*` path → the index compiler
    // has no column to emit and must fail loudly.
    expect(() =>
      buildSchemaStatements('firegraph', {
        coreIndexes: [{ fields: ['aType', 'garbage'] }],
      }),
    ).toThrow(/not a known firegraph field/);
  });

  it('rejects bogus table names at build time', () => {
    expect(() => buildSchemaStatements('1bad')).toThrow(/Invalid SQL identifier/);
    expect(() => buildSchemaStatements('has-hyphen')).toThrow(/Invalid SQL identifier/);
  });

  it('rejects empty `fields` arrays', () => {
    expect(() => buildSchemaStatements('firegraph', { coreIndexes: [{ fields: [] }] })).toThrow(
      /non-empty array/,
    );
  });
});

describe('sqlite-schema — bare `data` path', () => {
  it('emits json_extract on $ for an IndexSpec with fields: ["data"]', () => {
    // Bare `data` (no dotted suffix) compiles to an expression index on the
    // root JSON object. Rare but legal — and covers a distinct branch in
    // the DDL compiler's field-to-column mapping.
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'data'] }],
    });
    expect(stmts[1]).toContain(`json_extract("data", '$')`);
  });
});

describe('sqlite-schema — idempotency', () => {
  it('every index uses CREATE INDEX IF NOT EXISTS', () => {
    const stmts = buildSchemaStatements('firegraph');
    for (const s of stmts.slice(1)) {
      expect(s).toContain('CREATE INDEX IF NOT EXISTS');
    }
  });

  it('every index name is quoted', () => {
    const stmts = buildSchemaStatements('firegraph');
    for (const s of stmts.slice(1)) {
      expect(s).toMatch(/CREATE INDEX IF NOT EXISTS "[^"]+"/);
    }
  });
});
