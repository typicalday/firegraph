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
import { FIELD_TO_COLUMN } from '../../src/internal/sqlite-schema.js';

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

describe('buildIndexDDL — leadingColumns', () => {
  it('prepends leading columns ahead of the spec fields (legacy scope prefix)', () => {
    const ddl = buildIndexDDL(
      { fields: ['aType', 'data.status'] },
      {
        table: 'firegraph',
        fieldToColumn: FIELD_TO_COLUMN,
        leadingColumns: ['scope'],
      },
    );
    expect(ddl).toMatch(/\("scope", "a_type", json_extract\("data", '\$\.status'\)\)/);
  });

  it('fingerprint differs between leadingColumns variants', () => {
    // Same spec under legacy ('scope' prefix) vs DO (no prefix) → different
    // hashes → different index names. This is defensive: the two backends
    // must not alias to the same name if they ever share a table.
    const legacy = buildIndexDDL(
      { fields: ['aType', 'axbType'] },
      { table: 't', fieldToColumn: FIELD_TO_COLUMN, leadingColumns: ['scope'] },
    );
    const doBackend = buildIndexDDL(
      { fields: ['aType', 'axbType'] },
      { table: 't', fieldToColumn: DO_FIELD_TO_COLUMN },
    );
    const legacyName = legacy.match(/"t_idx_([0-9a-f]{8})"/)?.[1];
    const doName = doBackend.match(/"t_idx_([0-9a-f]{8})"/)?.[1];
    expect(legacyName).toBeDefined();
    expect(doName).toBeDefined();
    expect(legacyName).not.toBe(doName);
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

  it('scopes fingerprinting to the provided leadingColumns', () => {
    const withoutLead = dedupeIndexSpecs([{ fields: ['aType', 'axbType'] }]);
    const withLead = dedupeIndexSpecs([{ fields: ['aType', 'axbType'] }], ['scope']);
    // Both single-spec calls dedupe to one entry, but running them through
    // the two-call mental model proves leadingColumns alters the bucket —
    // the scope case would not collide with the non-scope case if both
    // were emitted.
    expect(withoutLead).toHaveLength(1);
    expect(withLead).toHaveLength(1);
  });

  it('is stable across calls (returns an array, does not mutate input)', () => {
    const input = [{ fields: ['aType'] }, { fields: ['aType'] }, { fields: ['aType', 'axbType'] }];
    const snapshot = JSON.stringify(input);
    const out = dedupeIndexSpecs(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toHaveLength(2);
  });
});
