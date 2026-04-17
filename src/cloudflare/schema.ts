/**
 * Flat SQLite schema for a single firegraph DO.
 *
 * Each `FiregraphDO` instance owns its own SQLite database and holds exactly
 * one subgraph's triples. Subgraph isolation is physical (one DO per
 * subgraph), so there is no `scope` column — every row in this DO belongs to
 * the same logical scope. This is the Cloudflare-native design: the scope
 * discriminator used by the legacy shared-table SQLite backend
 * (`src/internal/sqlite-schema.ts`) does not exist here.
 *
 * Document IDs:
 *   - Nodes: the UID itself
 *   - Edges: `shard:aUid:axbType:bUid`
 *
 * Indexes are defined for the patterns the query planner emits
 * (`src/query.ts`). No scope prefix is needed because rows never carry one.
 */

export const DO_COLUMNS = [
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

export type DOColumn = (typeof DO_COLUMNS)[number];

/**
 * Firegraph field name -> SQLite column name. Matches the legacy SQLite
 * backend's mapping so the query planner can compile filters identically.
 */
export const DO_FIELD_TO_COLUMN: Record<string, DOColumn> = {
  aType: 'a_type',
  aUid: 'a_uid',
  axbType: 'axb_type',
  bType: 'b_type',
  bUid: 'b_uid',
  v: 'v',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a SQLite identifier (table or column name). Identifier values in
 * this module come from config + constants, never from user data — but we
 * still fail fast if a caller passes a malformed table name, since the value
 * is interpolated directly into DDL.
 */
export function validateDOTableName(name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}. Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
  }
}

/**
 * Double-quote a SQLite identifier, after validating it against the allowed
 * character set. Used in generated SQL to protect against keyword collisions.
 */
export function quoteDOIdent(name: string): string {
  validateDOTableName(name);
  return `"${name}"`;
}

/**
 * DDL statements that create the firegraph table and its indexes. Returned
 * as separate statements because DO SQLite's `exec()` runs one statement per
 * call. Run via `FiregraphDO.ensureSchema()` on DO boot.
 */
export function buildDOSchemaStatements(table: string): string[] {
  const t = quoteDOIdent(table);
  return [
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
    `CREATE INDEX IF NOT EXISTS ${quoteDOIdent(`${table}_idx_a_uid`)} ON ${t}(a_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDOIdent(`${table}_idx_b_uid`)} ON ${t}(b_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDOIdent(`${table}_idx_axb_type_b_uid`)} ON ${t}(axb_type, b_uid)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDOIdent(`${table}_idx_a_type`)} ON ${t}(a_type)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDOIdent(`${table}_idx_b_type`)} ON ${t}(b_type)`,
  ];
}
