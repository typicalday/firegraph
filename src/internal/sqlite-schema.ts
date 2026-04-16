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
 */

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
 * Build the DDL statements that create the firegraph table and its indexes.
 * Returned as separate statements because some drivers (D1) require one
 * statement per `prepare()` call.
 */
export function buildSchemaStatements(table: string): string[] {
  const t = quoteIdent(table);
  return [
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
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_scope_a_uid`)} ON ${t}(scope, a_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_scope_b_uid`)} ON ${t}(scope, b_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_scope_axb_type_b_uid`)} ON ${t}(scope, axb_type, b_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_scope_a_type`)} ON ${t}(scope, a_type)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_scope_b_type`)} ON ${t}(scope, b_type)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${table}_idx_doc_id`)} ON ${t}(doc_id)`,
  ];
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
