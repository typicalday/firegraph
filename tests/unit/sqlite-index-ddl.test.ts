/**
 * Unit tests for the shared SQLite `IndexSpec` → DDL translator.
 *
 * Both the DO and legacy SQLite backends route their `IndexSpec[]` through
 * `buildIndexDDL` / `dedupeIndexSpecs` — isolating these helpers here keeps
 * the backend-specific test files focused on their own column mappings and
 * schema layout concerns.
 */
import { describe, expect, it } from 'vitest';

import { DO_FIELD_TO_COLUMN } from '../../src/cloudflare/schema.js';
import { buildIndexDDL, dedupeIndexSpecs } from '../../src/internal/sqlite-index-ddl.js';

describe('buildIndexDDL — top-level fields', () => {
  it('compiles a single firegraph field to its mapped column', () => {
    const ddl = buildIndexDDL(
      { fields: ['aType'] },
      { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    expect(ddl).toMatch(/CREATE INDEX IF NOT EXISTS "firegraph_idx_[0-9a-f]{8}"/);
    expect(ddl).toContain('ON "firegraph"');
    expect(ddl).toContain('"a_type"');
  });

  it('compiles a composite with mixed ASC/DESC', () => {
    const ddl = buildIndexDDL(
      {
        fields: [
          { path: 'aType', desc: false },
          { path: 'updatedAt', desc: true },
        ],
      },
      { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    expect(ddl).toMatch(/"a_type", "updated_at" DESC/);
  });

  it('emits a stable hashed name (identical specs produce identical DDL)', () => {
    const opts = { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN };
    const a = buildIndexDDL({ fields: ['aType', 'axbType'] }, opts);
    const b = buildIndexDDL({ fields: ['aType', 'axbType'] }, opts);
    expect(a).toBe(b);
  });
});

describe('buildIndexDDL — JSON path inlining', () => {
  it('inlines simple data.* paths as `$.key` literal', () => {
    const ddl = buildIndexDDL(
      { fields: ['aType', 'data.status'] },
      { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    expect(ddl).toContain(`json_extract("data", '$.status')`);
    expect(ddl).not.toContain(`json_extract("data", ?)`);
  });

  it('inlines nested data paths as `$.a.b.c`', () => {
    const ddl = buildIndexDDL(
      { fields: ['data.author.profile.name'] },
      { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    expect(ddl).toContain(`json_extract("data", '$.author.profile.name')`);
  });

  it('compiles bare `data` to `json_extract("data", \'$\')`', () => {
    const ddl = buildIndexDDL(
      { fields: ['data'] },
      { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    expect(ddl).toContain(`json_extract("data", '$')`);
  });

  it('rejects data.* paths with unsafe characters', () => {
    expect(() =>
      buildIndexDDL(
        { fields: ['data.bad key'] },
        { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
      ),
    ).toThrow(/invalid component "bad key"/);
  });

  it('rejects data.* paths starting with a digit', () => {
    expect(() =>
      buildIndexDDL(
        { fields: ['data.1st'] },
        { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
      ),
    ).toThrow(/invalid component/);
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      buildIndexDDL(
        { fields: ['nope'] },
        { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
      ),
    ).toThrow(/not a known firegraph field/);
  });
});

describe('buildIndexDDL — index name stability', () => {
  it('keeps index names stable across the removal of the legacy scope leading column', () => {
    // The fingerprint canonical form retains a `lead: []` key so the hash —
    // and therefore the index name — is identical to what the pre-refactor
    // DO backend (which never had a leading column) emitted. Existing DO
    // databases must not see their index names change.
    const ddl = buildIndexDDL(
      { fields: ['aType', 'axbType'] },
      { table: 't', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    const name = ddl.match(/"t_idx_([0-9a-f]{8})"/)?.[1];
    expect(name).toBeDefined();
    // Index columns carry no scope prefix.
    expect(ddl).toMatch(/ON "t"\("a_type", "axb_type"\)/);
    expect(ddl).not.toContain('"scope"');
  });
});

describe('buildIndexDDL — partial indexes', () => {
  it('appends the `where` predicate verbatim', () => {
    const ddl = buildIndexDDL(
      { fields: ['aType'], where: `json_extract("data", '$.archived') = 0` },
      {
        table: 'firegraph',
        fieldToColumn: DO_FIELD_TO_COLUMN,
      },
    );
    expect(ddl).toMatch(/WHERE json_extract\("data", '\$\.archived'\) = 0$/);
  });

  it('includes the `where` text in the fingerprint so predicate variants don’t collide', () => {
    const opts = { table: 't', fieldToColumn: DO_FIELD_TO_COLUMN };
    const a = buildIndexDDL({ fields: ['aType'], where: 'x = 1' }, opts);
    const b = buildIndexDDL({ fields: ['aType'], where: 'x = 2' }, opts);
    const aName = a.match(/"t_idx_([0-9a-f]{8})"/)?.[1];
    const bName = b.match(/"t_idx_([0-9a-f]{8})"/)?.[1];
    expect(aName).not.toBe(bName);
  });
});

describe('buildIndexDDL — input validation', () => {
  it('rejects empty fields arrays', () => {
    expect(() =>
      buildIndexDDL({ fields: [] }, { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN }),
    ).toThrow(/non-empty array/);
  });

  it('rejects malformed IndexFieldSpec objects', () => {
    expect(() =>
      buildIndexDDL(
        // @ts-expect-error intentionally malformed — no `path`.
        { fields: [{ desc: true }] },
        { table: 'firegraph', fieldToColumn: DO_FIELD_TO_COLUMN },
      ),
    ).toThrow(/IndexSpec field must be a string/);
  });
});

describe('dedupeIndexSpecs', () => {
  it('collapses two identical string-form specs to one', () => {
    const out = dedupeIndexSpecs([
      { fields: ['aType', 'axbType'] },
      { fields: ['aType', 'axbType'] },
    ]);
    expect(out).toHaveLength(1);
  });

  it('treats string-form and object-form ASC fields as identical', () => {
    // `'aType'` shorthand and `{ path: 'aType', desc: false }` must fingerprint
    // the same — normalization is part of the hash input.
    const out = dedupeIndexSpecs([
      { fields: ['aType', 'axbType'] },
      { fields: [{ path: 'aType' }, { path: 'axbType', desc: false }] },
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps specs with different field order as distinct entries', () => {
    // `(aType, axbType)` and `(axbType, aType)` are physically different
    // indexes (prefix coverage order matters) — must not collapse.
    const out = dedupeIndexSpecs([
      { fields: ['aType', 'axbType'] },
      { fields: ['axbType', 'aType'] },
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps specs with different `where` predicates distinct', () => {
    const out = dedupeIndexSpecs([
      { fields: ['aType'], where: 'x = 1' },
      { fields: ['aType'], where: 'x = 2' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('is stable across calls (returns an array, does not mutate input)', () => {
    const input = [{ fields: ['aType'] }, { fields: ['aType'] }, { fields: ['aType', 'axbType'] }];
    const snapshot = JSON.stringify(input);
    const out = dedupeIndexSpecs(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toHaveLength(2);
  });
});
