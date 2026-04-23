/**
 * SQLite schema for firegraph triples.
 *
 * Single-table design — both nodes (self-loops with `axbType = 'is'`) and
 * edges share one row. The `scope` column carries the materialized subgraph
 * path (parent UIDs interleaved with subgraph names), which preserves
 * Firestore's nested-subcollection semantics in a flat table.
 *
 * `data` is a JSON string. Built-in fields are projected to typed columns so
 * the query planner can use indexes without going through `json_extract`.
 *
 * ## Indexes
 *
 * Every index is prefixed with the `scope` column so the query compiler
 * (which always emits a `scope = ?` predicate) can use the index prefix
 * directly. This is the single difference from the DO SQLite backend, where
 * each DO is physically scoped and no discriminator column exists.
 *
 * Index specs come from the core preset (overridable via
 * `buildSchemaStatementsOptions.coreIndexes`) plus per-entry `indexes`
 * declared on registry entries. Specs are deduplicated by canonical
 * fingerprint before emission.
 */

import { DEFAULT_CORE_INDEXES } from '../default-indexes.js';
import type { GraphRegistry, IndexSpec } from '../types.js';
import { buildIndexDDL, dedupeIndexSpecs } from './sqlite-index-ddl.js';

export const SQLITE_COLUMNS = [
  'doc_id',
  'scope',
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
 * Build the DDL statements that create the firegraph table and its indexes.
 * Returned as separate statements because some drivers (D1) require one
 * statement per `prepare()` call.
 */
export function buildSchemaStatements(table: string, options: BuildSchemaOptions = {}): string[] {
  const t = quoteIdent(table);
  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${t} (
      doc_id      TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT '',
      a_type      TEXT NOT NULL,
      a_uid       TEXT NOT NULL,
      axb_type    TEXT NOT NULL,
      b_type      TEXT NOT NULL,
      b_uid       TEXT NOT NULL,
      data        TEXT NOT NULL,
      v           INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (scope, doc_id)
    )`,
    // `doc_id`-only index for edge-doc lookup across scopes (the primary key
    // leads with `scope`, so a scope-less lookup wouldn't otherwise hit it).
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_doc_id`)} ON ${t}(doc_id)`,
  ];

  const core = options.coreIndexes ?? [...DEFAULT_CORE_INDEXES];
  const fromRegistry = options.registry?.entries().flatMap((e) => e.indexes ?? []) ?? [];

  const leadingColumns = ['scope'];
  const deduped = dedupeIndexSpecs([...core, ...fromRegistry], leadingColumns);
  for (const spec of deduped) {
    statements.push(buildIndexDDL(spec, { table, fieldToColumn: FIELD_TO_COLUMN, leadingColumns }));
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
