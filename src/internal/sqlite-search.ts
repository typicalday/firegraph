/**
 * Search compilation for the local SQLite backend (`firegraph/sqlite-local`).
 *
 * Two capabilities are compiled here:
 *
 *   - **`search.fullText`** — an FTS5 index table per graph table, kept in
 *     sync by pure-SQL triggers. Text is extracted from the `data` JSON via
 *     `json_tree(...) WHERE type = 'text'`, so the triggers work from ANY
 *     connection or process touching the file — no user-defined function
 *     required on the write path. Queries rank with `bm25()` (lower =
 *     better, so `ORDER BY bm25 ASC` is relevance-descending).
 *
 *     Optionally, specific a_types get their OWN per-type FTS5 partition table
 *     (`perTypeFtsTableName`, `_fts_t_` infix) so their `bm25()` IDF is
 *     isolated from other a_types (the shared index mixes every a_type's
 *     document frequencies). A partition is declared per-field via
 *     `IndexSpec.fullText: { fields }` on a registry entry (index only those
 *     paths) or all-text via the legacy `perTypeFtsStats` backend option; the
 *     two merge into one `PerTypeFtsConfig` (`buildPerTypeFtsConfig`). Each
 *     partition is maintained by its OWN triggers (`buildPerTypeFtsDDL`), NOT
 *     folded into the shared triggers, so a consumer's `extraTableDDL`
 *     customisation of the shared triggers is never clobbered. A single-a_type
 *     search auto-routes to the partition unless the caller passes
 *     `perTypeStats: false`.
 *
 *   - **`search.vector`** — brute-force k-NN via a deterministic scalar UDF
 *     (`firegraph_vector_distance`) registered on the better-sqlite3
 *     connection by `createLocalSqliteBackend`. There is no ANN index; the
 *     engine evaluates the distance per candidate row, which is the right
 *     trade-off for the local-file use case (thousands to low millions of
 *     rows, zero infrastructure). UDFs are connection-local: vector search
 *     only works through a connection that registered the function.
 *
 * ## FTS row keying
 *
 * The FTS5 table's `rowid` is keyed through a dedicated mapping table
 * (`<t>_fts_map`, `INTEGER PRIMARY KEY AUTOINCREMENT` → `doc_id`) rather
 * than the graph table's own rowid. The graph table has a TEXT primary key,
 * so its raw rowids are NOT stable — `VACUUM` may renumber them, silently
 * detaching every FTS entry. AUTOINCREMENT ids survive VACUUM. Storing
 * `doc_id` UNINDEXED inside the FTS table was also rejected: FTS5 can't
 * index UNINDEXED columns, making the per-write delete a full scan.
 *
 * Validation parity: error messages and codes mirror the Firestore helpers
 * (`firestore-vector.ts` / `firestore-fulltext.ts`) so a caller migrating
 * between backends sees the same failures. This module must stay free of
 * `@google-cloud/firestore` imports — it is bundled into the
 * `firegraph/sqlite-local` entry.
 */

import { FiregraphError } from '../errors.js';
import { mangleStorageScope } from '../sqlite/catalog.js';
import type {
  FindNearestParams,
  FullTextSearchParams,
  GraphRegistry,
  QueryFilter,
} from '../types.js';
import { validateJsonPathKey } from './sqlite-data-ops.js';
import { quoteIdent } from './sqlite-schema.js';
import type { CompiledStatement } from './sqlite-sql.js';
import { compileFilterConditions } from './sqlite-sql.js';

/** Name of the connection-local vector-distance UDF (JSON-string path). */
export const VECTOR_DISTANCE_UDF = 'firegraph_vector_distance';

/**
 * Name of the connection-local vector-distance UDF that scores a Float64
 * little-endian BLOB shadow column directly, skipping the per-row
 * `JSON.parse` the JSON-path UDF pays. Registered alongside
 * `VECTOR_DISTANCE_UDF`; used only for DECLARED + MATERIALIZED vector fields.
 */
export const VECTOR_DISTANCE_BLOB_UDF = 'firegraph_vector_distance_blob';

/** Column alias carrying the computed distance through the vector query. */
export const DISTANCE_ALIAS = '__fg_distance';

const BACKEND_ERR_LABEL = 'SQLite backend';

/**
 * Built-in envelope fields that must NOT be passed as search field paths.
 * Mirrors the Firestore helpers' rejection list.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  'aType',
  'aUid',
  'axbType',
  'bType',
  'bUid',
  'createdAt',
  'updatedAt',
  'v',
]);

/** FTS5 index table for a graph table. */
export function ftsTableName(table: string): string {
  return `${table}_fts`;
}

/** Stable-rowid mapping table for a graph table's FTS index. */
export function ftsMapTableName(table: string): string {
  return `${table}_fts_map`;
}

/**
 * Per-type FTS config-fingerprint table, ONE per database, keyed by the ROOT
 * table name (not each graph table). Rows are `(table_name, a_type,
 * fingerprint)` where `fingerprint` is the canonical JSON of the a_type's
 * declared field list at the time its partition was last materialized. The
 * factory's `ftsEnsure` step reads it to detect a field-list CHANGE (purge +
 * rebuild the partition on mismatch) and NEVER creates it when the unified
 * per-type config is empty (byte-identity guarantee for no-opt-in databases).
 */
export function ftsCfgTableName(rootTable: string): string {
  return `${rootTable}_fts_cfg`;
}

/**
 * Supplementary per-type FTS5 table for one `(graph table, a_type)` pair —
 * the opt-in mechanism that gives a single `a_type` its own BM25 statistics
 * (`bm25()` computes IDF over the WHOLE physical index, so the shared
 * `<t>_fts` mixes every a_type's document frequencies together and inserting
 * other-type rows shifts within-type ranking; a per-type table holds only
 * that a_type's rows, so its IDF is isolated).
 *
 * WHY CONFIGURED (opt-in) AND NOT DYNAMIC: the FTS sync triggers are pure
 * SQL that must run identically from ANY connection or process touching the
 * file (the "any-connection invariant"), and a trigger body cannot
 * parameterize a table name. Creating a per-type table on demand at write
 * time would break that invariant, so the set of per-type a_types is declared
 * up front (`perTypeFtsStats` backend option) and the triggers carry literal,
 * escaped `a_type` guards.
 *
 * NAMING — the `_fts_t_` infix (NOT the bare `_fts_<mangled>` the design
 * sketch used) is deliberate and load-bearing for correctness. FTS5 creates
 * shadow tables for the shared index named `<t>_fts_data`, `<t>_fts_idx`,
 * `<t>_fts_docsize`, `<t>_fts_config`, and the stable-rowid map is
 * `<t>_fts_map`. A bare `<t>_fts_<mangleStorageScope(aType)>` would COLLIDE
 * with those whenever a configured a_type is `data` / `idx` / `docsize` /
 * `config` / `content` / `map` (all pass through `mangleStorageScope`
 * unchanged) — `CREATE VIRTUAL TABLE <t>_fts_data` would clash with the
 * shared index's own `_data` shadow. The `_t_` infix cannot equal any FTS5
 * shadow suffix or the `map` suffix, so per-type tables and their own shadow
 * tables never collide with the shared index's artifacts. `mangleStorageScope`
 * is injective, so two distinct a_types never collide with each other either.
 */
export function perTypeFtsTableName(table: string, aType: string): string {
  return `${table}_fts_t_${mangleStorageScope(aType)}`;
}

/** Escape a string literal for inline SQL (standard single-quote doubling). */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Per-type full-text configuration: `a_type` → the declared field list, or
 * `null` when the a_type opts in through the legacy all-text `perTypeFtsStats`
 * backend option (index every string value, byte-identical extraction to the
 * shared `<t>_fts`). A non-null value is a NON-EMPTY, de-duplicated, SORTED
 * list of bare `data`-relative field paths (`'title'`, `'meta.notes'`) declared
 * via `IndexSpec.fullText` on registry entries. Built once at factory time by
 * `buildPerTypeFtsConfig`; consumed by every per-type DDL / compile helper.
 */
export type PerTypeFtsConfig = ReadonlyMap<string, readonly string[] | null>;

/** Config entries in deterministic `a_type`-ascending order for stable DDL. */
function sortedPerTypeFtsEntries(
  config: PerTypeFtsConfig,
): Array<[string, readonly string[] | null]> {
  return [...config.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * The three per-type trigger names for one `(graph table, a_type)` pair.
 * Named off the partition table (`perTypeFtsTableName`) so every per-type
 * trigger carries the load-bearing `_fts_t_` infix — the stale-trigger sweep
 * in the factory's `ftsEnsure` step scans for exactly `<t>_fts_t_*` triggers.
 * `_bd` is BEFORE DELETE (not `_ad`) on purpose: it must fire and read the
 * `<t>_fts_map` row BEFORE the shared `<t>_fts_ad` AFTER DELETE trigger removes
 * that map row, so the per-type partition delete never races a vanished map id.
 */
export function perTypeFtsTriggerNames(
  table: string,
  aType: string,
): { ai: string; au: string; bd: string } {
  const base = perTypeFtsTableName(table, aType);
  return { ai: `${base}_ai`, au: `${base}_au`, bd: `${base}_bd` };
}

/**
 * SQL fragment extracting text out of a `data` JSON payload as one
 * space-joined blob. Pure SQL (`json_tree`), so it is evaluatable inside
 * triggers from any connection.
 *
 *   - `fields` UNDEFINED (or omitted) → index EVERY string value anywhere in
 *     `data` (`json_tree` over the whole payload). This is the all-text form
 *     the shared `<t>_fts` index and the legacy `perTypeFtsStats` (null-config)
 *     partitions use; the emitted string is byte-identical to the pre-per-type
 *     DDL, so `buildFtsDDL` stays backward compatible.
 *   - `fields` a NON-EMPTY list of bare `data`-relative paths → index only the
 *     text under those paths. Each path roots a `json_tree(..., '$.<path>')`
 *     subtree walk (so a path pointing at an object/array contributes every
 *     string beneath it); the per-path walks are `UNION ALL`-ed. Paths are
 *     validated by `collectFullTextDeclarations` at factory time, so the
 *     inlined `$.<path>` is injection-safe.
 */
function textExtractionExpr(dataRef: string, fields?: readonly string[]): string {
  if (fields === undefined) {
    return (
      `(SELECT coalesce(group_concat("value", ' '), '') ` +
      `FROM json_tree(coalesce(${dataRef}, '{}')) WHERE "type" = 'text')`
    );
  }
  const branches = fields
    .map(
      (field) =>
        `SELECT "value" FROM json_tree(coalesce(${dataRef}, '{}'), '$.${field}') ` +
        `WHERE "type" = 'text'`,
    )
    .join(' UNION ALL ');
  return `(SELECT coalesce(group_concat("value", ' '), '') FROM (${branches}))`;
}

/** One shared FTS trigger: its unquoted name and its canonical CREATE statement. */
export interface SharedFtsTriggerDef {
  /** Unquoted trigger name (`<t>_fts_ai` / `_au` / `_ad`). */
  name: string;
  /** Canonical `CREATE TRIGGER IF NOT EXISTS …` statement. */
  statement: string;
}

/**
 * The three shared FTS triggers (`<t>_fts_ai` / `_au` / `_ad`) for one graph
 * table, as `{ name, statement }` pairs. Single source of truth for the shared
 * trigger bodies: `buildFtsDDL` emits their statements, and the factory's
 * `ftsEnsure` legacy-heal step re-runs the exact statement string here to
 * replace a 0.19.0 folded trigger (whose body contained per-type
 * `<t>_fts_t_…` maintenance) with this clean shared-only body.
 *
 * The AFTER INSERT trigger also fires for the INSERT arm of the backend's
 * upsert (`INSERT … ON CONFLICT DO UPDATE`); the conflict arm fires AFTER
 * UPDATE. Both re-derive the indexed text from `new."data"`, and both start
 * with a defensive delete of any stale FTS row so replayed writes never
 * double-index. All three are `CREATE TRIGGER IF NOT EXISTS` — the shared body
 * never varies, so a plain idempotent create is correct (the folding that PR
 * #37 added has been removed; per-type maintenance now lives in separate
 * `perTypeFtsTriggerNames` triggers built by `buildPerTypeFtsDDL`).
 */
export function sharedFtsTriggerDefs(table: string): SharedFtsTriggerDef[] {
  const t = quoteIdent(table);
  const fts = quoteIdent(ftsTableName(table));
  const map = quoteIdent(ftsMapTableName(table));
  const mappedId = `(SELECT "id" FROM ${map} WHERE "doc_id" = new."doc_id")`;
  // The map insert must be conflict-free rather than `INSERT OR IGNORE`:
  // when the outer statement is the backend's upsert (`INSERT … ON CONFLICT
  // DO UPDATE`), SQLite replaces conflict handling inside trigger programs
  // with the outer statement's algorithm, turning the IGNORE into an abort.
  const reindexBody =
    `  INSERT INTO ${map} ("doc_id") SELECT new."doc_id" ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${map} WHERE "doc_id" = new."doc_id");\n` +
    `  DELETE FROM ${fts} WHERE rowid = ${mappedId};\n` +
    `  INSERT INTO ${fts} (rowid, "text") VALUES (${mappedId}, ${textExtractionExpr('new."data"')});\n`;
  const aiName = `${table}_fts_ai`;
  const auName = `${table}_fts_au`;
  const adName = `${table}_fts_ad`;
  const adSuffix = `AFTER DELETE ON ${t} BEGIN
  DELETE FROM ${fts} WHERE rowid = (SELECT "id" FROM ${map} WHERE "doc_id" = old."doc_id");
  DELETE FROM ${map} WHERE "doc_id" = old."doc_id";
END`;
  return [
    {
      name: aiName,
      statement: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(aiName)} AFTER INSERT ON ${t} BEGIN\n${reindexBody}END`,
    },
    {
      name: auName,
      statement: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(auName)} AFTER UPDATE ON ${t} BEGIN\n${reindexBody}END`,
    },
    {
      name: adName,
      statement: `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(adName)} ${adSuffix}`,
    },
  ];
}

/**
 * DDL installing the SHARED FTS5 infrastructure for one graph table: the
 * mapping table, the FTS5 virtual table, and the three shared sync triggers
 * (`sharedFtsTriggerDefs`). Safe to re-run on every bootstrap: the table /
 * virtual-table statements are `IF NOT EXISTS` and the triggers are
 * `CREATE TRIGGER IF NOT EXISTS`. The emitted strings are byte-identical to
 * the pre-per-type (pre-PR-#37) DDL — per-type maintenance is NO LONGER folded
 * into these triggers; it lives in separate per-type triggers built by
 * `buildPerTypeFtsDDL`.
 */
export function buildFtsDDL(table: string): string[] {
  const fts = quoteIdent(ftsTableName(table));
  const map = quoteIdent(ftsMapTableName(table));
  return [
    `CREATE TABLE IF NOT EXISTS ${map} (
      "id"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "doc_id" TEXT NOT NULL UNIQUE
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5("text")`,
    ...sharedFtsTriggerDefs(table).map((def) => def.statement),
  ];
}

/**
 * Idempotent reconciliation statements run at every schema bootstrap,
 * after `buildFtsDDL`:
 *
 *   1–2. Purge FTS/map rows whose `doc_id` no longer exists in the graph
 *        table. Covers the recreate-after-cascade path: a parent cascade
 *        DROPs the graph table (taking the triggers with it) but leaves
 *        the FTS artifacts; without the purge, a recreated subgraph would
 *        surface ghost matches and hit UNIQUE violations on the map.
 *   3–4. Backfill map/FTS rows for graph rows that predate the FTS
 *        infrastructure (e.g. a database written by an older firegraph).
 */
export function buildFtsSyncStatements(table: string): string[] {
  const t = quoteIdent(table);
  const fts = quoteIdent(ftsTableName(table));
  const map = quoteIdent(ftsMapTableName(table));
  return [
    `DELETE FROM ${fts} WHERE rowid IN (
      SELECT m."id" FROM ${map} m LEFT JOIN ${t} t ON t."doc_id" = m."doc_id"
      WHERE t."doc_id" IS NULL
    )`,
    `DELETE FROM ${map} WHERE "doc_id" NOT IN (SELECT "doc_id" FROM ${t})`,
    `INSERT OR IGNORE INTO ${map} ("doc_id") SELECT "doc_id" FROM ${t}`,
    `INSERT INTO ${fts} (rowid, "text")
      SELECT m."id", ${textExtractionExpr('t."data"')}
      FROM ${t} t JOIN ${map} m ON m."doc_id" = t."doc_id"
      WHERE m."id" NOT IN (SELECT rowid FROM ${fts})`,
  ];
}

/**
 * DDL installing one supplementary per-type FTS5 partition table
 * (`perTypeFtsTableName`) and its three OWN maintenance triggers
 * (`perTypeFtsTriggerNames`) for each configured a_type. Emitted ALONGSIDE the
 * shared `buildFtsDDL` output, never folded into the shared triggers.
 *
 * WHY SEPARATE, DROP+CREATE'd TRIGGERS (not folded, not `IF NOT EXISTS`):
 *
 *   - SEPARATE (own triggers) so a consumer's `extraTableDDL` customisation of
 *     the shared `<t>_fts_ai/_au/_ad` triggers is never clobbered — the bug PR
 *     #37 introduced by folding per-type maintenance into the shared bodies.
 *   - DROP+CREATE (unconditional, not `IF NOT EXISTS`) so a field-list change
 *     on an existing DB deterministically reconciles the installed trigger body
 *     to the current `fields` on every bootstrap; a plain `CREATE … IF NOT
 *     EXISTS` would leave a stale body indexing the old field set.
 *
 * The `_bd` trigger is BEFORE DELETE so it reads the `<t>_fts_map` row before
 * the shared `<t>_fts_ad` AFTER DELETE trigger removes it (no inter-trigger
 * ordering race). Each per-type trigger carries its OWN idempotent map-ensure
 * (the `WHERE NOT EXISTS` form, matching the shared trigger's conflict-free
 * insert) so a per-type-only opt-in still populates the shared map. The upsert
 * body deletes unconditionally (covers reindex AND a row LEAVING the type on an
 * `a_type` change) then re-inserts only when the row still belongs to the type.
 */
export function buildPerTypeFtsDDL(table: string, config: PerTypeFtsConfig): string[] {
  const t = quoteIdent(table);
  const map = quoteIdent(ftsMapTableName(table));
  const mappedId = `(SELECT "id" FROM ${map} WHERE "doc_id" = new."doc_id")`;
  const mappedIdOld = `(SELECT "id" FROM ${map} WHERE "doc_id" = old."doc_id")`;
  const statements: string[] = [];
  for (const [aType, fields] of sortedPerTypeFtsEntries(config)) {
    const ptfts = quoteIdent(perTypeFtsTableName(table, aType));
    const literal = `'${escapeSqlLiteral(aType)}'`;
    const extraction = textExtractionExpr('new."data"', fields === null ? undefined : fields);
    const names = perTypeFtsTriggerNames(table, aType);
    const ai = quoteIdent(names.ai);
    const au = quoteIdent(names.au);
    const bd = quoteIdent(names.bd);
    const upsertBody =
      `  INSERT INTO ${map} ("doc_id") SELECT new."doc_id" ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${map} WHERE "doc_id" = new."doc_id");\n` +
      `  DELETE FROM ${ptfts} WHERE rowid = ${mappedId};\n` +
      `  INSERT INTO ${ptfts} (rowid, "text") ` +
      `SELECT ${mappedId}, ${extraction} WHERE new."a_type" = ${literal};\n`;
    const deleteBody = `  DELETE FROM ${ptfts} WHERE rowid = ${mappedIdOld};\n`;
    statements.push(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${ptfts} USING fts5("text")`,
      `DROP TRIGGER IF EXISTS ${ai}`,
      `CREATE TRIGGER ${ai} AFTER INSERT ON ${t} BEGIN\n${upsertBody}END`,
      `DROP TRIGGER IF EXISTS ${au}`,
      `CREATE TRIGGER ${au} AFTER UPDATE ON ${t} BEGIN\n${upsertBody}END`,
      `DROP TRIGGER IF EXISTS ${bd}`,
      `CREATE TRIGGER ${bd} BEFORE DELETE ON ${t} BEGIN\n${deleteBody}END`,
    );
  }
  return statements;
}

/**
 * Idempotent reconciliation statements for the per-type partition tables, run
 * at every bootstrap AFTER the shared `buildFtsSyncStatements` (so the shared
 * `<t>_fts_map` rows the partitions key off already exist). For each configured
 * a_type: purge ghosts (map row's `doc_id` gone OR its `a_type` no longer this
 * type), then insert only the type's rows that are missing — using the
 * field-filtered extraction so the backfill matches the trigger body. Covers
 * rows that PRE-DATE the opt-in (or predate this a_type / field set), plus the
 * recreate-after-cascade path. A field-list CHANGE on already-indexed rows is
 * handled by `ftsEnsure` (full partition purge on fingerprint mismatch), which
 * then re-runs these statements.
 */
export function buildPerTypeFtsSyncStatements(table: string, config: PerTypeFtsConfig): string[] {
  const t = quoteIdent(table);
  const map = quoteIdent(ftsMapTableName(table));
  const statements: string[] = [];
  for (const [aType, fields] of sortedPerTypeFtsEntries(config)) {
    const ptfts = quoteIdent(perTypeFtsTableName(table, aType));
    const literal = `'${escapeSqlLiteral(aType)}'`;
    const extraction = textExtractionExpr('t."data"', fields === null ? undefined : fields);
    statements.push(
      `DELETE FROM ${ptfts} WHERE rowid IN (
      SELECT m."id" FROM ${map} m LEFT JOIN ${t} t ON t."doc_id" = m."doc_id"
      WHERE t."doc_id" IS NULL OR t."a_type" <> ${literal}
    )`,
      `INSERT INTO ${ptfts} (rowid, "text")
      SELECT m."id", ${extraction}
      FROM ${t} t JOIN ${map} m ON m."doc_id" = t."doc_id"
      WHERE t."a_type" = ${literal} AND m."id" NOT IN (SELECT rowid FROM ${ptfts})`,
    );
  }
  return statements;
}

/**
 * Full `extraTableDDL` payload for `firegraph/sqlite-local`: shared FTS
 * infrastructure + per-type partitions + both reconciliation passes, in the
 * order shared-DDL → per-type-DDL → shared-sync → per-type-sync (per-type sync
 * depends on the shared map being backfilled first). An EMPTY `config`
 * reproduces the pre-per-type payload exactly (shared DDL + shared sync only),
 * so a backend with no `IndexSpec.fullText` and no `perTypeFtsStats` is
 * byte-identical to today.
 */
export function buildLocalSearchDDL(table: string, config: PerTypeFtsConfig = new Map()): string[] {
  return [
    ...buildFtsDDL(table),
    ...buildPerTypeFtsDDL(table, config),
    ...buildFtsSyncStatements(table),
    ...buildPerTypeFtsSyncStatements(table, config),
  ];
}

/**
 * Normalise a caller-supplied vector / distance-result field path. Bare
 * names rewrite to `data.<name>`; `'data'` and `'data.*'` pass through;
 * envelope fields are rejected. Same contract and message shape as
 * `normalizeVectorFieldPath` in `firestore-vector.ts`.
 */
export function normalizeVectorFieldPath(label: string, field: string): string {
  if (ENVELOPE_FIELDS.has(field)) {
    throw new FiregraphError(
      `findNearest(): ${label} '${field}' is a built-in envelope field — ` +
        `vectors must live under \`data.*\`. Use a path like 'data.${field}' ` +
        `if you really meant a nested data field.`,
      'INVALID_QUERY',
    );
  }
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Normalise a caller-supplied FTS field path. Same contract as
 * `normalizeFullTextFieldPath` in `firestore-fulltext.ts`.
 */
export function normalizeFullTextFieldPath(field: string): string {
  if (ENVELOPE_FIELDS.has(field)) {
    throw new FiregraphError(
      `fullTextSearch(): field '${field}' is a built-in envelope field — ` +
        `text-indexed fields must live under \`data.*\`. Use a path like ` +
        `'data.${field}' if you really meant a nested data field.`,
      'INVALID_QUERY',
    );
  }
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Identifying filters (`aType` / `axbType` / `bType`) plus optional `where`.
 * Bare `where` field names rewrite to `data.<name>` — the same convention
 * `buildEdgeQueryPlan` applies for `findEdges({ where })`.
 */
function buildSearchFilters(params: {
  aType?: string;
  axbType?: string;
  bType?: string;
  where?: QueryFilter[];
}): QueryFilter[] {
  const filters: QueryFilter[] = [];
  if (params.aType) filters.push({ field: 'aType', op: '==', value: params.aType });
  if (params.axbType) filters.push({ field: 'axbType', op: '==', value: params.axbType });
  if (params.bType) filters.push({ field: 'bType', op: '==', value: params.bType });
  for (const clause of params.where ?? []) {
    const field =
      ENVELOPE_FIELDS.has(clause.field) || clause.field.startsWith('data.')
        ? clause.field
        : `data.${clause.field}`;
    filters.push({ field, op: clause.op, value: clause.value });
  }
  return filters;
}

/**
 * Compile a `fullTextSearch()` call into one SELECT over the FTS5 index.
 *
 * Validation parity with `runFirestoreFullTextSearch`: non-empty string
 * query, positive integer limit, and a non-empty `fields` list is rejected
 * with `INVALID_QUERY` ("not yet supported") — FTS5 column filters could
 * support per-field search later, but the single-blob index built today
 * has one `text` column, so the option is reserved rather than silently
 * mis-honoured.
 *
 * Results order by `bm25()` ascending (best match first), with `doc_id`
 * as a deterministic tie-break.
 */
export function compileFullTextSearch(
  table: string,
  params: FullTextSearchParams,
  config: PerTypeFtsConfig = new Map(),
): CompiledStatement {
  if (typeof params.query !== 'string' || params.query.length === 0) {
    throw new FiregraphError(
      'fullTextSearch(): query must be a non-empty string.',
      'INVALID_QUERY',
    );
  }
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new FiregraphError(
      `fullTextSearch(): limit must be a positive integer (got ${params.limit}).`,
      'INVALID_QUERY',
    );
  }
  const normalizedFields = params.fields?.map((f) => normalizeFullTextFieldPath(f));
  if (normalizedFields !== undefined && normalizedFields.length > 0) {
    throw new FiregraphError(
      'fullTextSearch(): the `fields` option is not yet supported — ' +
        'the local SQLite FTS index stores one combined text column per record. ' +
        'Omit `fields` to search all string values.',
      'INVALID_QUERY',
    );
  }

  const t = quoteIdent(table);
  // Routing to the per-type partition is DEFAULT-ON: the partition is used
  // whenever the search targets exactly one a_type that HAS a configured
  // partition for this graph table, UNLESS the caller explicitly opts out with
  // `perTypeStats: false`. Any other shape falls back to the shared `<t>_fts`
  // (no aType / multiple types / unconfigured type) — a non-error fallback, so
  // cross-type search is unchanged. The partition shares the `<t>_fts_map`
  // rowid, so only the FTS/MATCH/bm25 table changes; the map + base joins and
  // the a_type WHERE predicate stay identical.
  const usePerType =
    typeof params.aType === 'string' && config.has(params.aType) && params.perTypeStats !== false;
  const fts = quoteIdent(
    usePerType ? perTypeFtsTableName(table, params.aType as string) : ftsTableName(table),
  );
  const map = quoteIdent(ftsMapTableName(table));

  const sqlParams: unknown[] = [params.query];
  const conditions: string[] = [`${fts} MATCH ?`];
  conditions.push(...compileFilterConditions(buildSearchFilters(params), sqlParams));
  sqlParams.push(params.limit);

  const sql =
    `SELECT ${t}.* FROM ${fts} ` +
    `JOIN ${map} ON ${map}."id" = ${fts}.rowid ` +
    `JOIN ${t} ON ${t}."doc_id" = ${map}."doc_id" ` +
    `WHERE ${conditions.join(' AND ')} ` +
    `ORDER BY bm25(${fts}) ASC, ${t}."doc_id" ASC LIMIT ?`;
  return { sql, params: sqlParams };
}

/**
 * Substrings that identify a malformed-FTS5-query failure raised by the
 * FTS5 MATCH parser at *query* time.
 *
 * FTS5 reports a bad MATCH expression as a generic `SQLITE_ERROR` (the same
 * code used for ordinary SQL logic errors), not as a distinct error code, so
 * a raw better-sqlite3 `SqliteError` would otherwise escape `fullTextSearch()`
 * instead of the documented `INVALID_QUERY` (the Firestore-parity contract).
 * Matching the parser's specific complaints lets us translate query-syntax
 * failures while leaving genuine storage failures (disk I/O, corruption, lock
 * contention, a non-healable `no such table`) — which carry different messages
 * / codes — to propagate unchanged.
 *
 * Observed shapes (`code === 'SQLITE_ERROR'` for all):
 *   - `"unclosed phrase (((` → `"unterminated string"`        (unclosed quote)
 *   - `AND AND`              → `"fts5: syntax error near ..."` (grammar error)
 *   - `* leading`            → `"unknown special query: ..."`  (bad directive)
 *   - `col: bar`             → `"no such column: col"`          (column filter)
 *
 * `no such column` is safe to treat as a query error here: every column the
 * compiled statement references is a fixed, real column, so the only runtime
 * source of that message is an FTS5 `col:term` filter inside the user's MATCH
 * expression — it can never originate from a genuine missing column. A
 * `no such table` miss is distinct ("table", not "column") and is handled
 * upstream by the self-heal retry, so it never reaches this matcher's scope.
 */
const FTS5_QUERY_ERROR_SIGNATURES: readonly string[] = [
  'fts5: syntax error',
  'unterminated string',
  'unknown special query',
  'no such column',
];

/**
 * True when `message` is the FTS5 MATCH parser rejecting a malformed query
 * string — the failures `fullTextSearch()` must surface as `INVALID_QUERY`
 * rather than as a raw driver error. See `FTS5_QUERY_ERROR_SIGNATURES`.
 */
export function isFts5QueryError(message: string): boolean {
  const lower = message.toLowerCase();
  return FTS5_QUERY_ERROR_SIGNATURES.some((sig) => lower.includes(sig));
}

/**
 * True when a thrown error is SQLite's read-only-database write rejection.
 * better-sqlite3 and node:sqlite both surface it as "attempt to write a
 * readonly database" (SQLITE_READONLY). The `findNearest` read path uses this
 * to tolerate a failing schema/vector bootstrap on a read-only handle and fall
 * through to the pure-JSON query branch — the schema a read-only DB needs was
 * necessarily materialized while it was still writable.
 */
export function isReadonlyWriteError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /readonly|read-only|SQLITE_READONLY/i.test(message);
}

const DISTANCE_MEASURES: ReadonlySet<string> = new Set(['EUCLIDEAN', 'COSINE', 'DOT_PRODUCT']);

export interface CompiledVectorQuery {
  stmt: CompiledStatement;
  /**
   * `data`-relative path segments to write the computed distance into on
   * each result record, or `null` when `distanceResultField` was not set.
   */
  distancePath: string[] | null;
}

/** Resolve a `queryVector` argument to a plain `number[]`. */
function toNumberArray(qv: number[] | { toArray(): number[] }): number[] {
  if (Array.isArray(qv)) return qv;
  if (typeof (qv as { toArray?: unknown }).toArray === 'function') {
    return (qv as { toArray(): number[] }).toArray();
  }
  throw new FiregraphError(
    'findNearest(): queryVector must be a number[] or a Firestore VectorValue.',
    'INVALID_QUERY',
  );
}

/**
 * Compile a `findNearest()` call into one SELECT that scores every
 * candidate row via the `firegraph_vector_distance` UDF.
 *
 * Shape (subquery because SQLite forbids referencing a SELECT alias in
 * the same level's WHERE):
 *
 *   SELECT * FROM (
 *     SELECT *, firegraph_vector_distance(json_extract("data", '$.<path>'), ?, ?) AS "__fg_distance"
 *     FROM "<t>" [WHERE <identifiers + where>]
 *   ) WHERE "__fg_distance" IS NOT NULL [AND "__fg_distance" <=|>= ?]
 *   ORDER BY "__fg_distance" ASC|DESC, "doc_id" ASC LIMIT ?
 *
 * `NULL` distances (missing field, non-array value, dimension mismatch)
 * drop out of the result, mirroring Firestore's behaviour of silently
 * skipping non-conforming documents. Threshold and ordering semantics
 * follow the `FindNearestParams.distanceThreshold` contract: `<=` /
 * ascending for EUCLIDEAN and COSINE, `>=` / descending for DOT_PRODUCT.
 *
 * Validation parity with `runFirestoreFindNearest`: envelope-field
 * rejection on both field params, non-empty query vector, positive
 * integer limit ≤ 1000.
 *
 * `declaredVectors` lists ONLY the declared vector fields whose Float64 LE
 * BLOB shadow column PROVABLY EXISTS on the handle running the query (the
 * factories compute this from a `PRAGMA table_info` check + read-only
 * guard). When the requested `vectorField` matches one, the score
 * expression becomes a CASE that scores the blob column via
 * `firegraph_vector_distance_blob` when it is non-NULL and falls back to the
 * JSON-path UDF otherwise (a not-yet-backfilled or wrong-dimension row).
 * Undeclared / unmaterialized fields keep exactly today's pure-JSON path.
 */
export function compileFindNearest(
  table: string,
  params: FindNearestParams,
  declaredVectors?: ReadonlyArray<DeclaredVector>,
): CompiledVectorQuery {
  const vec = toNumberArray(params.queryVector);
  if (vec.length === 0) {
    throw new FiregraphError(
      'findNearest(): queryVector is empty — at least one dimension is required.',
      'INVALID_QUERY',
    );
  }
  if (!Number.isInteger(params.limit) || params.limit <= 0 || params.limit > 1000) {
    throw new FiregraphError(
      `findNearest(): limit must be a positive integer ≤ 1000 (got ${params.limit}).`,
      'INVALID_QUERY',
    );
  }
  if (!DISTANCE_MEASURES.has(params.distanceMeasure)) {
    throw new FiregraphError(
      `findNearest(): unknown distanceMeasure '${String(params.distanceMeasure)}' — ` +
        `expected EUCLIDEAN, COSINE, or DOT_PRODUCT.`,
      'INVALID_QUERY',
    );
  }

  const vectorField = normalizeVectorFieldPath('vectorField', params.vectorField);
  let vectorExpr: string;
  let bareField: string | null = null;
  if (vectorField === 'data') {
    vectorExpr = '"data"';
  } else {
    const suffix = vectorField.slice('data.'.length);
    for (const part of suffix.split('.')) {
      validateJsonPathKey(part, BACKEND_ERR_LABEL);
    }
    vectorExpr = `json_extract("data", '$.${suffix}')`;
    bareField = suffix;
  }

  // Blob fast path only when the requested field is a declared vector whose
  // shadow column exists on this handle.
  const declared =
    bareField !== null ? declaredVectors?.find((d) => d.field === bareField) : undefined;

  let distancePath: string[] | null = null;
  if (params.distanceResultField !== undefined) {
    const normalized = normalizeVectorFieldPath('distanceResultField', params.distanceResultField);
    if (normalized === 'data') {
      throw new FiregraphError(
        `findNearest(): distanceResultField 'data' would replace the entire data ` +
          `payload — use a nested path like 'data.distance'.`,
        'INVALID_QUERY',
      );
    }
    distancePath = normalized.slice('data.'.length).split('.');
    for (const part of distancePath) {
      validateJsonPathKey(part, BACKEND_ERR_LABEL);
    }
  }

  // Bound-parameter order tracks placeholder order in the statement text:
  // the UDF arguments in the SELECT list come first (the CASE has TWO
  // placeholder pairs — blob branch, then JSON branch — so push in textual
  // order), then the inner WHERE filters, then threshold and limit.
  const queryJson = JSON.stringify(vec);
  const sqlParams: unknown[] = [];
  let scoreExpr: string;
  if (declared) {
    const col = quoteIdent(declared.shadowColumn);
    scoreExpr =
      `CASE WHEN ${col} IS NOT NULL ` +
      `THEN ${VECTOR_DISTANCE_BLOB_UDF}(${col}, ?, ?) ` +
      `ELSE ${VECTOR_DISTANCE_UDF}(${vectorExpr}, ?, ?) END`;
    sqlParams.push(queryJson, params.distanceMeasure, queryJson, params.distanceMeasure);
  } else {
    scoreExpr = `${VECTOR_DISTANCE_UDF}(${vectorExpr}, ?, ?)`;
    sqlParams.push(queryJson, params.distanceMeasure);
  }
  const conditions = compileFilterConditions(buildSearchFilters(params), sqlParams);
  const innerWhere = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const dist = quoteIdent(DISTANCE_ALIAS);
  const descending = params.distanceMeasure === 'DOT_PRODUCT';

  let sql =
    `SELECT * FROM (` +
    `SELECT *, ${scoreExpr} AS ${dist} ` +
    `FROM ${quoteIdent(table)}${innerWhere}` +
    `) WHERE ${dist} IS NOT NULL`;
  if (params.distanceThreshold !== undefined) {
    sql += ` AND ${dist} ${descending ? '>=' : '<='} ?`;
    sqlParams.push(params.distanceThreshold);
  }
  sql += ` ORDER BY ${dist} ${descending ? 'DESC' : 'ASC'}, "doc_id" ASC LIMIT ?`;
  sqlParams.push(params.limit);

  return { stmt: { sql, params: sqlParams }, distancePath };
}

// One-entry memo for the parsed query vector: the UDF runs once per
// candidate row with the identical query-vector JSON, so re-parsing it
// every call would dominate the scan cost.
let memoQueryJson: string | null = null;
let memoQueryVec: number[] | null = null;

/**
 * Scalar UDF body for `firegraph_vector_distance(storedJson, queryJson,
 * measure)`. Returns the distance as a REAL, or `null` when the stored
 * value is missing, not a JSON array, dimension-mismatched, or contains
 * non-finite/non-numeric entries — NULL rows are filtered out by the
 * query, mirroring Firestore's silent skip of non-conforming documents.
 *
 * COSINE returns `1 − cos(a, b)` (Firestore's distance convention) and
 * `null` when either vector has zero norm (cosine undefined).
 *
 * Exported for direct unit testing and registered on the connection by
 * `createLocalSqliteBackend` with `deterministic: true`.
 */
export function computeVectorDistance(
  storedJson: unknown,
  queryJson: unknown,
  measure: unknown,
): number | null {
  if (
    typeof storedJson !== 'string' ||
    typeof queryJson !== 'string' ||
    typeof measure !== 'string'
  ) {
    return null;
  }
  let query: number[];
  if (memoQueryJson === queryJson && memoQueryVec !== null) {
    query = memoQueryVec;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(queryJson);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    query = parsed as number[];
    memoQueryJson = queryJson;
    memoQueryVec = query;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(storedJson);
  } catch {
    return null;
  }
  if (!Array.isArray(stored) || stored.length !== query.length) return null;

  let dot = 0;
  let sumSq = 0;
  let normStored = 0;
  let normQuery = 0;
  for (let i = 0; i < query.length; i++) {
    const a = stored[i];
    const b = query[i];
    if (typeof a !== 'number' || !Number.isFinite(a)) return null;
    if (typeof b !== 'number' || !Number.isFinite(b)) return null;
    dot += a * b;
    const diff = a - b;
    sumSq += diff * diff;
    normStored += a * a;
    normQuery += b * b;
  }

  let result: number;
  switch (measure) {
    case 'EUCLIDEAN':
      result = Math.sqrt(sumSq);
      break;
    case 'COSINE': {
      const denom = Math.sqrt(normStored) * Math.sqrt(normQuery);
      if (denom === 0) return null;
      result = 1 - dot / denom;
      break;
    }
    case 'DOT_PRODUCT':
      result = dot;
      break;
    default:
      return null;
  }
  return Number.isFinite(result) ? result : null;
}

/**
 * Derive the safe SQLite column identifier for a declared vector field's
 * shadow BLOB. `field` is a bare `data`-relative name (no `data.` prefix).
 * Each dotted part is validated with `validateJsonPathKey` — the same rule
 * the query path enforces — so exotic keys fail loudly rather than
 * producing an unquotable column. Dots become underscores so
 * `'nested.vec'` maps to `'__vec_nested_vec'`.
 */
export function vectorShadowColumn(field: string): string {
  for (const part of field.split('.')) {
    validateJsonPathKey(part, BACKEND_ERR_LABEL);
  }
  return `__vec_${field.replace(/\./g, '_')}`;
}

/**
 * Encode a numeric vector as a Float64 little-endian BLOB. The byte layout
 * mirrors `DataView.getFloat64(offset, true)` so `computeVectorDistanceBlob`
 * reconstructs the exact same doubles that `computeVectorDistance` reads
 * from the JSON path — the basis of the byte-identical-ranking guarantee.
 *
 * Bound as a SQL parameter for the backfill UPDATE: better-sqlite3 and
 * node:sqlite both bind a `Uint8Array` as a BLOB.
 */
export function encodeVectorBlob(vec: number[]): Uint8Array {
  const buf = new ArrayBuffer(vec.length * 8);
  const view = new DataView(buf);
  for (let i = 0; i < vec.length; i++) {
    view.setFloat64(i * 8, vec[i], true);
  }
  return new Uint8Array(buf);
}

/**
 * Scalar UDF body for `firegraph_vector_distance_blob(storedBlob, queryJson,
 * measure)`. Math-identical to `computeVectorDistance`, but reads the stored
 * vector from a Float64 little-endian BLOB instead of a JSON string — no
 * per-row `JSON.parse`.
 *
 * Accepts whatever the driver hands a BLOB column: a `Uint8Array` (node:sqlite
 * and better-sqlite3 both pass a `Buffer`, which is a `Uint8Array` subclass)
 * or an `ArrayBuffer`. Honors the view's `byteOffset` / `byteLength`. Returns
 * `null` (row drops out, same as the JSON path) when the byte length is not a
 * multiple of 8, the decoded dimension mismatches the query, or any entry is
 * non-finite / non-numeric.
 *
 * The query-vector parse is memoized through the SAME module-level memo as
 * `computeVectorDistance`: within one findNearest the query JSON string is
 * identical across both UDFs, so the parse is paid once per query, not per row.
 *
 * Exported for direct unit testing (parity with `computeVectorDistance`).
 */
export function computeVectorDistanceBlob(
  storedBlob: unknown,
  queryJson: unknown,
  measure: unknown,
): number | null {
  if (typeof queryJson !== 'string' || typeof measure !== 'string') {
    return null;
  }

  let view: DataView;
  let byteLength: number;
  if (storedBlob instanceof Uint8Array) {
    // Covers Node `Buffer` (a Uint8Array subclass) — respect byteOffset.
    view = new DataView(storedBlob.buffer, storedBlob.byteOffset, storedBlob.byteLength);
    byteLength = storedBlob.byteLength;
  } else if (storedBlob instanceof ArrayBuffer) {
    view = new DataView(storedBlob);
    byteLength = storedBlob.byteLength;
  } else {
    return null;
  }

  let query: number[];
  if (memoQueryJson === queryJson && memoQueryVec !== null) {
    query = memoQueryVec;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(queryJson);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    query = parsed as number[];
    memoQueryJson = queryJson;
    memoQueryVec = query;
  }

  if (byteLength % 8 !== 0) return null;
  const dim = byteLength / 8;
  if (dim !== query.length) return null;

  let dot = 0;
  let sumSq = 0;
  let normStored = 0;
  let normQuery = 0;
  for (let i = 0; i < dim; i++) {
    const a = view.getFloat64(i * 8, true);
    const b = query[i];
    if (!Number.isFinite(a)) return null;
    if (typeof b !== 'number' || !Number.isFinite(b)) return null;
    dot += a * b;
    const diff = a - b;
    sumSq += diff * diff;
    normStored += a * a;
    normQuery += b * b;
  }

  let result: number;
  switch (measure) {
    case 'EUCLIDEAN':
      result = Math.sqrt(sumSq);
      break;
    case 'COSINE': {
      const denom = Math.sqrt(normStored) * Math.sqrt(normQuery);
      if (denom === 0) return null;
      result = 1 - dot / denom;
      break;
    }
    case 'DOT_PRODUCT':
      result = dot;
      break;
    default:
      return null;
  }
  return Number.isFinite(result) ? result : null;
}

/**
 * Pure-SQL trigger that NULLs a vector's shadow column whenever the row's
 * `data` changes, so the next `findNearest` backfill re-encodes it. AFTER
 * UPDATE only (a fresh column defaults NULL, so INSERT needs no trigger),
 * guarded by `WHEN new."data" IS NOT old."data"` — the backfill UPDATE
 * touches only the shadow column, leaving `data` untouched, so it does NOT
 * self-invalidate. SQLite can't assign `NEW.col` in a trigger, so this
 * issues a real UPDATE keyed by `doc_id`; recursive triggers are off by
 * default, so that UPDATE does not re-fire this trigger.
 */
export function buildVectorNullOnChangeTrigger(table: string, field: string): string {
  const t = quoteIdent(table);
  const col = quoteIdent(vectorShadowColumn(field));
  const name = quoteIdent(`${table}__vec_${field.replace(/\./g, '_')}_nullonchange`);
  return (
    `CREATE TRIGGER IF NOT EXISTS ${name} AFTER UPDATE ON ${t}\n` +
    `  WHEN new."data" IS NOT old."data" BEGIN\n` +
    `  UPDATE ${t} SET ${col} = NULL WHERE "doc_id" = new."doc_id";\n` +
    `END`
  );
}

/**
 * `ALTER TABLE … ADD COLUMN` for a vector's shadow BLOB. The single
 * non-idempotent statement in the ensure path — the factory guards it with
 * a `PRAGMA table_info` check and a duplicate-column catch.
 */
export function vectorAddColumnSql(table: string, field: string): string {
  return `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(vectorShadowColumn(field))} BLOB`;
}

/**
 * SELECT of the rows still needing a blob: shadow column IS NULL and the
 * JSON field is present. `v` carries the raw `json_extract` result (a JSON
 * text for an array value) which the factory parses + validates + encodes in
 * JS. `field` parts are validated by `vectorShadowColumn`, so the inlined
 * `$.<field>` JSON path is injection-safe.
 */
export function vectorBackfillSelectSql(table: string, field: string): string {
  const col = quoteIdent(vectorShadowColumn(field));
  const path = `$.${field}`;
  return (
    `SELECT "doc_id", json_extract("data", '${path}') AS v ` +
    `FROM ${quoteIdent(table)} ` +
    `WHERE ${col} IS NULL AND json_extract("data", '${path}') IS NOT NULL`
  );
}

/** UPDATE binding `[blob, doc_id]` to populate one row's shadow column. */
export function vectorBackfillUpdateSql(table: string, field: string): string {
  const col = quoteIdent(vectorShadowColumn(field));
  return `UPDATE ${quoteIdent(table)} SET ${col} = ? WHERE "doc_id" = ?`;
}

/**
 * A declared vector field whose shadow column PROVABLY EXISTS on the handle
 * running the query — the only kind `compileFindNearest` may reference in
 * SQL. Produced by the factories' JS ensure step.
 */
export interface DeclaredVector {
  field: string;
  dimension: number;
  shadowColumn: string;
}

/**
 * Collect vector declarations from a registry: flatten entries → indexes →
 * `spec.vector`, deduped by field. Throws `INVALID_ARGUMENT` if one field is
 * declared with two different dimensions (a shared physical table can hold
 * only one blob layout per field). Runs once at factory time so a
 * misconfigured registry fails fast at construction, not at query time.
 */
export function collectVectorDeclarations(
  registry: GraphRegistry | undefined,
): Array<{ field: string; dimension: number }> {
  if (!registry) return [];
  const byField = new Map<string, number>();
  for (const entry of registry.entries()) {
    for (const spec of entry.indexes ?? []) {
      if (spec.vector === undefined) continue;
      const { field, dimension } = spec.vector;
      // Validate the field name (rejects exotic keys) via the naming helper.
      vectorShadowColumn(field);
      const existing = byField.get(field);
      if (existing !== undefined && existing !== dimension) {
        throw new FiregraphError(
          `IndexSpec.vector: field '${field}' declared with conflicting dimensions ` +
            `(${existing} vs ${dimension}). A shared physical table can hold only one ` +
            `blob layout per field.`,
          'INVALID_ARGUMENT',
        );
      }
      byField.set(field, dimension);
    }
  }
  return [...byField.entries()].map(([field, dimension]) => ({ field, dimension }));
}

/**
 * Validate one declared full-text field path (a bare `data`-relative path like
 * `'title'` or `'meta.notes'`). Each dotted segment must satisfy
 * `validateJsonPathKey` — the same safe-identifier rule the query / index paths
 * enforce — so the path can be inlined into `json_tree(..., '$.<path>')` without
 * injection. `validateJsonPathKey` raises `INVALID_QUERY`; a bad DECLARATION is
 * a construction-time misconfiguration, so it is re-raised as `INVALID_ARGUMENT`.
 */
function validateFullTextFieldPath(aType: string, path: string): void {
  for (const part of path.split('.')) {
    try {
      validateJsonPathKey(part, BACKEND_ERR_LABEL);
    } catch (err) {
      throw new FiregraphError(
        `IndexSpec.fullText on a_type '${aType}': field path '${path}' has an ` +
          `unsafe segment '${part}'. ${err instanceof Error ? err.message : String(err)}`,
        'INVALID_ARGUMENT',
      );
    }
  }
}

/**
 * Collect per-type full-text declarations from a registry: flatten entries →
 * indexes → `spec.fullText`, group the declared `fields` by `aType`, then
 * UNION + de-dupe + SORT the field paths so two entries sharing an a_type merge
 * into one partition field set. Each field path is validated
 * (`validateFullTextFieldPath`); an empty `fields` array throws
 * `INVALID_ARGUMENT` (declare at least one field, or omit the whole spec).
 * Runs once at factory time so a misconfigured registry fails fast at
 * construction. Returns `a_type` → sorted field paths.
 */
export function collectFullTextDeclarations(
  registry: GraphRegistry | undefined,
): ReadonlyMap<string, readonly string[]> {
  const byType = new Map<string, Set<string>>();
  if (!registry) return new Map<string, readonly string[]>();
  for (const entry of registry.entries()) {
    for (const spec of entry.indexes ?? []) {
      if (spec.fullText === undefined) continue;
      const { fields } = spec.fullText;
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new FiregraphError(
          `IndexSpec.fullText on a_type '${entry.aType}': \`fields\` must be a ` +
            `non-empty array of data-relative field paths. Omit the whole \`fullText\` ` +
            `spec to not declare a per-type text index for this a_type.`,
          'INVALID_ARGUMENT',
        );
      }
      const set = byType.get(entry.aType) ?? new Set<string>();
      for (const path of fields) {
        validateFullTextFieldPath(entry.aType, path);
        set.add(path);
      }
      byType.set(entry.aType, set);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [aType, set] of byType) {
    result.set(aType, [...set].sort());
  }
  return result;
}

/**
 * Merge the two per-type full-text opt-in sources into one `PerTypeFtsConfig`:
 *
 *   - `IndexSpec.fullText` declarations (`collectFullTextDeclarations`) → the
 *     a_type maps to its sorted declared field list (field-filtered partition).
 *   - Legacy `perTypeFtsStats` backend option → the a_type maps to `null`
 *     (all-text partition, byte-identical extraction to the shared index).
 *
 * An a_type present in BOTH sources is a configuration conflict (all-text vs
 * field-filtered are mutually exclusive for one partition) and throws
 * `INVALID_ARGUMENT` at factory time.
 */
export function buildPerTypeFtsConfig(
  registry: GraphRegistry | undefined,
  perTypeFtsStats: readonly string[] = [],
): PerTypeFtsConfig {
  const config = new Map<string, readonly string[] | null>();
  for (const [aType, fields] of collectFullTextDeclarations(registry)) {
    config.set(aType, fields);
  }
  for (const aType of perTypeFtsStats) {
    if (config.has(aType)) {
      throw new FiregraphError(
        `a_type '${aType}' is declared for per-type full-text search in BOTH the ` +
          `\`perTypeFtsStats\` backend option (all-text) and \`IndexSpec.fullText\` ` +
          `(specific fields). Declare it in exactly one place.`,
        'INVALID_ARGUMENT',
      );
    }
    config.set(aType, null);
  }
  return config;
}

/**
 * Set a nested value inside a record's `data` payload, creating
 * intermediate objects along the way (replacing non-object intermediates,
 * matching Firestore's `distanceResultField` write semantics).
 */
export function setDataPath(
  data: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): void {
  let cursor = data;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Identify orphaned FTS artifacts (`<t>_fts` / `<t>_fts_map`, plus each
 * configured per-type `<t>_fts_t_<mangled>`) whose base graph table no longer
 * exists — left behind when a parent cascade DROPs a descendant subgraph
 * table (triggers die with the table; the FTS artifacts do not).
 *
 * Two-pass, driven by the KNOWN configured type list rather than suffix
 * guessing:
 *
 *   1. Discover orphaned BASE tables. A base is discovered from any surviving
 *      artifact — the shared `_fts` / `_fts_map` table, or a per-type table
 *      whose exact `_fts_t_<mangle(T)>` suffix (for a configured T) matches.
 *      Matching per-type suffixes FIRST is essential: a per-type table for an
 *      a_type that mangles to end in `fts` (e.g. a_type `"fts"`) would end in
 *      `_fts` and be mis-read as a shared index by naive suffix stripping.
 *   2. Emit the EXACT artifact names for each orphaned base (`ftsTableName`,
 *      `ftsMapTableName`, and `perTypeFtsTableName` per configured type) that
 *      actually exist and are not live graph tables.
 *
 * Safety against false positives: only bases under the subgraph prefix
 * (`<rootTable>_g_`) are considered, an artifact that is itself a registered
 * graph table (`catalogTables`) is never dropped, and the base must be absent
 * from `allTables`. FTS5 shadow tables (`<t>_fts_data`, `<t>_fts_idx`, … and
 * the per-type tables' own shadows) are dropped implicitly with their parent
 * virtual table, so they are never listed here.
 */
export function findOrphanedFtsTables(
  allTables: ReadonlyArray<string>,
  catalogTables: ReadonlyArray<string>,
  rootTable: string,
  configuredATypes: readonly string[] = [],
): string[] {
  const names = new Set(allTables);
  const liveGraphTables = new Set(catalogTables);
  const subgraphPrefix = `${rootTable}_g_`;
  const perTypeSuffixes = configuredATypes.map((aType) => `_fts_t_${mangleStorageScope(aType)}`);

  // Pass 1: collect orphaned base tables.
  const orphanedBases = new Set<string>();
  const considerBase = (base: string | null, artifact: string): void => {
    if (base === null || !base.startsWith(subgraphPrefix)) return;
    if (liveGraphTables.has(artifact)) return; // artifact is itself a live graph table
    if (names.has(base)) return; // base still exists → not orphaned
    orphanedBases.add(base);
  };
  for (const name of names) {
    const ptSuffix = perTypeSuffixes.find(
      (suffix) => name.length > suffix.length && name.endsWith(suffix),
    );
    if (ptSuffix !== undefined) {
      considerBase(name.slice(0, -ptSuffix.length), name);
      continue;
    }
    if (name.endsWith('_fts_map')) {
      considerBase(name.slice(0, -'_fts_map'.length), name);
      continue;
    }
    if (name.endsWith('_fts')) {
      considerBase(name.slice(0, -'_fts'.length), name);
    }
  }

  // Pass 2: emit exact, existing, non-live artifact names for each base.
  const orphans = new Set<string>();
  for (const base of orphanedBases) {
    const artifacts = [
      ftsTableName(base),
      ftsMapTableName(base),
      ...configuredATypes.map((aType) => perTypeFtsTableName(base, aType)),
    ];
    for (const artifact of artifacts) {
      if (names.has(artifact) && !liveGraphTables.has(artifact)) orphans.add(artifact);
    }
  }
  return [...orphans].sort();
}
