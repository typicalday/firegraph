/**
 * Legacy shared-table SQLite schema unit tests.
 *
 * The legacy SQLite backend (D1, Node better-sqlite3, etc.) uses a single
 * table with a `scope` column for subgraph isolation. Every index is
 * prefixed with the `scope` column so the query compiler (which always
 * emits a `scope = ?` predicate) can use the index directly.
 *
 * Contrast with the DO SQLite backend where each DO physically scopes its
 * own rows and no `scope` column exists.
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

  it('maps firegraph fields to columns (with the scope-aware shape)', () => {
    expect(FIELD_TO_COLUMN).toMatchObject({
      aType: 'a_type',
      aUid: 'a_uid',
      axbType: 'axb_type',
      bType: 'b_type',
      bUid: 'b_uid',
    });
  });
});

describe('sqlite-schema — buildSchemaStatements defaults', () => {
  it('emits CREATE TABLE with scope + composite PK', () => {
    const stmts = buildSchemaStatements('firegraph');
    const tableDDL = stmts[0];
    expect(tableDDL).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
    expect(tableDDL).toContain('scope');
    expect(tableDDL).toContain('PRIMARY KEY (scope, doc_id)');
  });

  it('emits a scope-less doc_id index for cross-scope edge lookups', () => {
    const stmts = buildSchemaStatements('firegraph');
    const docIdIdx = stmts.find((s) => s.includes(`"firegraph_idx_doc_id"`));
    expect(docIdIdx).toBeDefined();
    expect(docIdIdx).toMatch(/ON "firegraph"\(doc_id\)/);
  });

  it('defaults to DEFAULT_CORE_INDEXES plus the doc_id index', () => {
    const stmts = buildSchemaStatements('firegraph');
    // 1 CREATE TABLE + 1 doc_id index + 8 core preset indexes = 10
    expect(stmts).toHaveLength(1 + 1 + DEFAULT_CORE_INDEXES.length);
  });

  it('prefixes every core-preset index with the `scope` column', () => {
    const stmts = buildSchemaStatements('firegraph');
    // Skip the CREATE TABLE (index 0) and the bare doc_id index (index 1).
    // Everything from index 2 onward should lead with "scope".
    for (const ddl of stmts.slice(2)) {
      expect(ddl).toMatch(/\("scope"/);
    }
  });
});

describe('sqlite-schema — coreIndexes override', () => {
  it('coreIndexes: [] disables the preset (CREATE TABLE + doc_id index only)', () => {
    const stmts = buildSchemaStatements('firegraph', { coreIndexes: [] });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE TABLE IF NOT EXISTS "firegraph"');
    expect(stmts[1]).toMatch(/"firegraph_idx_doc_id"/);
  });

  it('coreIndexes override replaces the preset', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
    });
    // CREATE TABLE + doc_id index + 1 core = 3
    expect(stmts).toHaveLength(3);
    expect(stmts[2]).toContain(`json_extract("data", '$.status')`);
    expect(stmts[2]).toMatch(/\("scope", "a_type", "axb_type"/);
  });

  it('inlines nested JSON paths in expression indexes', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', 'data.author.name'] }],
    });
    expect(stmts[2]).toContain(`json_extract("data", '$.author.name')`);
  });

  it('emits ASC/DESC order from IndexFieldSpec', () => {
    const stmts = buildSchemaStatements('firegraph', {
      coreIndexes: [{ fields: ['aType', { path: 'updatedAt', desc: true }] }],
    });
    expect(stmts[2]).toMatch(/"updated_at" DESC/);
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
    expect(stmts[2]).toMatch(/WHERE json_extract\("data", '\$\.archived'\) = 0$/);
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
    // CREATE TABLE + doc_id + 8 preset + 1 registry = 11
    expect(stmts).toHaveLength(11);
    const registryDDL = stmts.find((s) => s.includes(`'$.status'`));
    expect(registryDDL).toBeDefined();
    // Registry indexes also carry the `scope` leading column.
    expect(registryDDL!).toMatch(/\("scope", "a_type", "axb_type", json_extract/);
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
    // CREATE TABLE + doc_id + 8 preset (no extra from registry) = 10
    expect(stmts).toHaveLength(10);
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
    expect(stmts[2]).toContain(`json_extract("data", '$')`);
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
