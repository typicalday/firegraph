/**
 * SQLite schema for firegraph triples.
 *
 * Single-table design — both nodes (self-loops with `axbType = 'is'`) and
 * edges share one row shape. Each table holds exactly one graph's triples:
 * subgraph isolation is physical (one table per graph, or one Durable
 * Object per graph on Cloudflare), so there is no `scope` discriminator
 * column. The table a row lives in *is* its scope.
 *
 * `data` is a JSON string. Built-in fields are projected to typed columns so
 * the query planner can use indexes without going through `json_extract`.
 *
 * ## Indexes
 *
 * Index specs come from the core preset (overridable via
 * `BuildSchemaOptions.coreIndexes`) plus per-entry `indexes` declared on
 * registry entries. Specs are deduplicated by canonical fingerprint before
 * emission.
 */

import { DEFAULT_CORE_INDEXES } from '../default-indexes.js';
import type { GraphRegistry, IndexSpec } from '../types.js';
import { buildIndexDDL, dedupeIndexSpecs } from './sqlite-index-ddl.js';

export const SQLITE_COLUMNS = [
  'doc_id',
  'a_type',
  'a_uid',
  'axb_type',
  'b_type',
  'b_uid',
  'data',
  'v',
  'created_at',
  'updated_at',
] as const;

export type SqliteColumn = (typeof SQLITE_COLUMNS)[number];

/**
 * Map firegraph field names (as they appear in `QueryFilter.field` and the
 * record envelope) to SQLite column names.
 */
export const FIELD_TO_COLUMN: Record<string, SqliteColumn> = {
  aType: 'a_type',
  aUid: 'a_uid',
  axbType: 'axb_type',
  bType: 'b_type',
  bUid: 'b_uid',
  v: 'v',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

/**
 * Options controlling DDL emission for `buildSchemaStatements`.
 */
export interface BuildSchemaOptions {
  /**
   * Replaces the built-in core preset. Defaults to `DEFAULT_CORE_INDEXES`.
   * Pass `[]` to disable core indexes entirely.
   */
  coreIndexes?: IndexSpec[];
  /**
   * Registry contributing per-triple `indexes` declarations.
   */
  registry?: GraphRegistry;
}

/**
 * Build the DDL statements that create one graph's triple table and its
 * indexes. Returned as separate statements because some drivers (D1, DO
 * SQLite's `exec()`) require one statement per call.
 *
 * The CREATE TABLE statement is always first; index statements follow in
 * deterministic order. Same specs across runs produce the same statements,
 * so `CREATE … IF NOT EXISTS` is idempotent.
 */
export function buildSchemaStatements(table: string, options: BuildSchemaOptions = {}): string[] {
  const t = quoteIdent(table);
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${t} (
      doc_id      TEXT NOT NULL PRIMARY KEY,
      a_type      TEXT NOT NULL,
      a_uid       TEXT NOT NULL,
      axb_type    TEXT NOT NULL,
      b_type      TEXT NOT NULL,
      b_uid       TEXT NOT NULL,
      data        TEXT NOT NULL,
      v           INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )`,
  ];

  const core = options.coreIndexes ?? [...DEFAULT_CORE_INDEXES];
  const fromRegistry = options.registry?.entries().flatMap((e) => e.indexes ?? []) ?? [];

  const deduped = dedupeIndexSpecs([...core, ...fromRegistry]);
  for (const spec of deduped) {
    statements.push(buildIndexDDL(spec, { table, fieldToColumn: FIELD_TO_COLUMN }));
  }
  return statements;
}

/**
 * Quote a SQL identifier with double quotes, escaping any embedded quotes.
 *
 * Identifier names (table, column, index) come from configuration and
 * static code in this module — never from user data — but quoting still
 * protects against accidental keyword collisions.
 */
export function quoteIdent(name: string): string {
  validateTableName(name);
  return `"${name}"`;
}

/**
 * Validate a SQLite identifier (table name, column name) against the
 * allowed character set. Exposed so factory functions can fail fast on
 * an invalid `options.table` rather than waiting until first SQL.
 */
export function validateTableName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}. Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
  }
}

/**
 * Quote a SQL column-alias label. Unlike `quoteIdent` (which validates the
 * input as a SQL identifier and is used for table/column names), this helper
 * accepts arbitrary text — projection aliases are pure labels we read back
 * out of the result row, never executed as identifiers, so they can carry
 * dots (e.g. `data.detail.region`) and other characters that
 * `validateTableName` rejects.
 *
 * Embedded double quotes are escaped per the SQL standard (`"` → `""`),
 * which is sufficient to prevent the alias text from terminating the quoted
 * label early. This is the only injection vector for an alias — even if
 * the input contained `";--`, double-quote escaping would render it
 * `""";--` inside `"..."`, harmless.
 *
 * Used by `compileFindEdgesProjected` for the caller-supplied projection
 * field name; the underlying SQL expression (`json_extract(...)`, column
 * reference) still goes through the strict compiler with no caller input.
 */
export function quoteColumnAlias(label: string): string {
  return `"${label.replace(/"/g, '""')}"`;
}
