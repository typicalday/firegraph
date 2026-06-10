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
import type { FindNearestParams, FullTextSearchParams, QueryFilter } from '../types.js';
import { validateJsonPathKey } from './sqlite-data-ops.js';
import { quoteIdent } from './sqlite-schema.js';
import type { CompiledStatement } from './sqlite-sql.js';
import { compileFilterConditions } from './sqlite-sql.js';

/** Name of the connection-local vector-distance UDF. */
export const VECTOR_DISTANCE_UDF = 'firegraph_vector_distance';

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
 * SQL fragment extracting every string value in a `data` JSON payload as
 * one space-joined text blob. Pure SQL (`json_tree`), so it is evaluatable
 * inside triggers from any connection.
 */
function textExtractionExpr(dataRef: string): string {
  return (
    `(SELECT coalesce(group_concat("value", ' '), '') ` +
    `FROM json_tree(coalesce(${dataRef}, '{}')) WHERE "type" = 'text')`
  );
}

/**
 * DDL installing the FTS5 infrastructure for one graph table: the mapping
 * table, the FTS5 virtual table, and three sync triggers. All statements
 * are `IF NOT EXISTS` — safe to re-run on every bootstrap.
 *
 * The AFTER INSERT trigger also fires for the INSERT arm of the backend's
 * upsert (`INSERT … ON CONFLICT DO UPDATE`); the conflict arm fires AFTER
 * UPDATE. Both re-derive the indexed text from `new."data"`, and both
 * start with a defensive delete of any stale FTS row so replayed writes
 * never double-index.
 */
export function buildFtsDDL(table: string): string[] {
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
  return [
    `CREATE TABLE IF NOT EXISTS ${map} (
      "id"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "doc_id" TEXT NOT NULL UNIQUE
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5("text")`,
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${table}_fts_ai`)} AFTER INSERT ON ${t} BEGIN\n${reindexBody}END`,
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${table}_fts_au`)} AFTER UPDATE ON ${t} BEGIN\n${reindexBody}END`,
    `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${table}_fts_ad`)} AFTER DELETE ON ${t} BEGIN
  DELETE FROM ${fts} WHERE rowid = (SELECT "id" FROM ${map} WHERE "doc_id" = old."doc_id");
  DELETE FROM ${map} WHERE "doc_id" = old."doc_id";
END`,
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
 * Full `extraTableDDL` payload for `firegraph/sqlite-local`: FTS
 * infrastructure plus the reconciliation pass.
 */
export function buildLocalSearchDDL(table: string): string[] {
  return [...buildFtsDDL(table), ...buildFtsSyncStatements(table)];
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
  const fts = quoteIdent(ftsTableName(table));
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
 */
export function compileFindNearest(table: string, params: FindNearestParams): CompiledVectorQuery {
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
  if (vectorField === 'data') {
    vectorExpr = '"data"';
  } else {
    const suffix = vectorField.slice('data.'.length);
    for (const part of suffix.split('.')) {
      validateJsonPathKey(part, BACKEND_ERR_LABEL);
    }
    vectorExpr = `json_extract("data", '$.${suffix}')`;
  }

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
  // the two UDF arguments in the SELECT list come first, then the inner
  // WHERE filters, then threshold and limit.
  const sqlParams: unknown[] = [JSON.stringify(vec), params.distanceMeasure];
  const conditions = compileFilterConditions(buildSearchFilters(params), sqlParams);
  const innerWhere = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const dist = quoteIdent(DISTANCE_ALIAS);
  const descending = params.distanceMeasure === 'DOT_PRODUCT';

  let sql =
    `SELECT * FROM (` +
    `SELECT *, ${VECTOR_DISTANCE_UDF}(${vectorExpr}, ?, ?) AS ${dist} ` +
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
 * Identify orphaned FTS artifacts (`<t>_fts` / `<t>_fts_map`) whose base
 * graph table no longer exists — left behind when a parent cascade DROPs a
 * descendant subgraph table (triggers die with the table; the FTS
 * artifacts do not).
 *
 * Safety against false positives: only names under the subgraph prefix
 * (`<rootTable>_g_`) are considered, a candidate must NOT itself be a
 * registered graph table (`catalogTables` — covers a real graph whose
 * mangled scope happens to end in `_fts`), and its base table must be
 * absent from `allTables`. FTS5 shadow tables (`<t>_fts_data`,
 * `<t>_fts_idx`, …) never match the suffix patterns and are dropped
 * implicitly with their parent virtual table.
 */
export function findOrphanedFtsTables(
  allTables: ReadonlyArray<string>,
  catalogTables: ReadonlyArray<string>,
  rootTable: string,
): string[] {
  const names = new Set(allTables);
  const liveGraphTables = new Set(catalogTables);
  const subgraphPrefix = `${rootTable}_g_`;
  const orphans: string[] = [];
  for (const name of names) {
    let base: string | null = null;
    if (name.endsWith('_fts_map')) base = name.slice(0, -'_fts_map'.length);
    else if (name.endsWith('_fts')) base = name.slice(0, -'_fts'.length);
    if (base === null || !base.startsWith(subgraphPrefix)) continue;
    if (liveGraphTables.has(name)) continue;
    if (names.has(base)) continue;
    orphans.push(name);
  }
  return orphans.sort();
}
