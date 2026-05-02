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
 * Indexes come from two sources and are appended to the DDL list:
 *
 *  1. The core preset (`DEFAULT_CORE_INDEXES`), overridable per-DO via
 *     `FiregraphDOOptions.coreIndexes`.
 *  2. Per-registry-entry `indexes` declared on `RegistryEntry` (from code or
 *     `meta.json` via entity discovery).
 *
 * Both sets are deduplicated by canonical fingerprint, so declaring the same
 * composite twice (e.g., by preset + registry entry) collapses to one
 * `CREATE INDEX`.
 */

import { DEFAULT_CORE_INDEXES } from '../default-indexes.js';
import { buildIndexDDL, dedupeIndexSpecs } from '../internal/sqlite-index-ddl.js';
import type { GraphRegistry, IndexSpec } from '../types.js';

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
 * Quote a SQL column-alias label. Unlike `quoteDOIdent` (which validates
 * the input as a SQL identifier and is used for table/column names), this
 * helper accepts arbitrary text — projection aliases are pure labels we
 * read back out of the result row, never executed as identifiers, so they
 * can carry dots (e.g. `data.detail.region`) and other characters that the
 * strict identifier validator rejects.
 *
 * Embedded double quotes are escaped per the SQL standard (`"` → `""`),
 * which is sufficient to prevent the alias text from terminating the
 * quoted label early. Mirrors `quoteColumnAlias` in
 * `src/internal/sqlite-schema.ts`; both backends share the same projection
 * contract, so the alias quoter behaviour must match.
 */
export function quoteDOColumnAlias(label: string): string {
  return `"${label.replace(/"/g, '""')}"`;
}

/**
 * Options controlling DDL emission for `buildDOSchemaStatements`.
 */
export interface BuildDOSchemaOptions {
  /**
   * Replaces the built-in core preset. Defaults to `DEFAULT_CORE_INDEXES`.
   * Pass `[]` to disable core indexes entirely.
   */
  coreIndexes?: IndexSpec[];
  /**
   * Registry contributing per-triple `indexes` declarations. Entries with
   * no `indexes` field are ignored; the rest are flattened and deduplicated
   * against the core preset by canonical fingerprint.
   */
  registry?: GraphRegistry;
}

/**
 * DDL statements that create the firegraph table and its indexes. Returned
 * as separate statements because DO SQLite's `exec()` runs one statement per
 * call. Run via `FiregraphDO.ensureSchema()` on DO boot.
 *
 * The CREATE TABLE statement is always first; index statements follow in
 * deterministic order. Same specs across runs produce the same statements,
 * so `CREATE INDEX IF NOT EXISTS` is idempotent.
 */
export function buildDOSchemaStatements(
  table: string,
  options: BuildDOSchemaOptions = {},
): string[] {
  const t = quoteDOIdent(table);
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
    statements.push(buildIndexDDL(spec, { table, fieldToColumn: DO_FIELD_TO_COLUMN }));
  }
  return statements;
}
