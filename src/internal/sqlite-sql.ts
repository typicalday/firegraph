/**
 * Compile firegraph queries and writes into parameterized SQLite statements.
 *
 * The single-table SQLite schema mirrors the Firestore record envelope:
 * built-in fields (`aType`, `aUid`, etc.) are typed columns, and `data` is a
 * JSON string. `data.<key>` filter fields are translated to `json_extract`
 * expressions; built-in fields go straight to their column.
 */

import { FiregraphError } from '../errors.js';
import type { GraphTimestamp } from '../timestamp.js';
import { GraphTimestampImpl } from '../timestamp.js';
import type { QueryFilter, QueryOptions, StoredGraphRecord } from '../types.js';
import type { UpdatePayload, WritableRecord, WriteMode } from './backend.js';
import { assertJsonSafePayload } from './sqlite-payload-guard.js';
import { FIELD_TO_COLUMN, quoteIdent } from './sqlite-schema.js';
import type { DataPathOp } from './write-plan.js';
import { assertUpdatePayloadExclusive, flattenPatch } from './write-plan.js';

const SQLITE_BACKEND_LABEL = 'shared-table SQLite';

export interface CompiledStatement {
  sql: string;
  params: unknown[];
}

/**
 * Translate a firegraph filter field to either a column reference or a
 * `json_extract("data", '$.<path>')` expression with the JSON path
 * **inlined as a string literal** — not parametrized.
 *
 * Inlining matters: SQLite's query planner matches an expression index
 * (`CREATE INDEX … ON tbl(json_extract("data", '$.status'))`) against
 * *textually identical* expressions in the WHERE clause. `json_extract(
 * "data", ?)` with the path as a bound parameter would never hit the
 * index, so every `data.*` filter would fall back to a full scan even
 * when a matching expression index exists. The index builder in
 * `sqlite-index-ddl.ts` emits the inlined form, and this compiler must
 * match it verbatim.
 *
 * Safety: each path component passes `JSON_PATH_KEY_RE`
 * (`/^[A-Za-z_][A-Za-z0-9_-]*$/`) before embedding, which excludes every
 * character SQLite treats as syntax (quote, dot, bracket, whitespace).
 */
function compileFieldRef(field: string): { expr: string } {
  const column = FIELD_TO_COLUMN[field];
  if (column) {
    return { expr: quoteIdent(column) };
  }
  if (field.startsWith('data.')) {
    const suffix = field.slice(5);
    for (const part of suffix.split('.')) {
      validateJsonPathKey(part);
    }
    return { expr: `json_extract("data", '$.${suffix}')` };
  }
  if (field === 'data') {
    return { expr: `json_extract("data", '$')` };
  }
  throw new FiregraphError(`SQLite backend cannot resolve filter field: ${field}`, 'INVALID_QUERY');
}

/**
 * Constructor names of Firestore special types that don't survive a plain
 * JSON.stringify round-trip — they have non-enumerable accessors (e.g.
 * `Timestamp.seconds`) or class identity that JSON loses. Filtering by one
 * of these against SQLite would silently miss every row, so we fail loudly.
 *
 * Detection is by `constructor.name` + duck-type so this module stays
 * dependency-free (importing `@google-cloud/firestore` here would pollute
 * the Cloudflare Workers bundle — see tests/unit/bundle-pollution.test.ts).
 */
const FIRESTORE_TYPE_NAMES = new Set([
  'Timestamp',
  'GeoPoint',
  'VectorValue',
  'DocumentReference',
  'FieldValue',
]);

function isFirestoreSpecialType(value: object): string | null {
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && FIRESTORE_TYPE_NAMES.has(ctorName)) return ctorName;
  return null;
}

/**
 * Coerce a JS filter value into a SQLite-bindable primitive. JS objects
 * (other than null) are JSON-stringified so they can match values stored
 * via `json_extract`.
 *
 * Firestore special types (Timestamp, GeoPoint, VectorValue,
 * DocumentReference, FieldValue) are rejected with `INVALID_QUERY` —
 * `JSON.stringify` would emit garbage (`{}` for Timestamp, etc.) that
 * silently fails to match anything. Convert to a primitive at the call site
 * (e.g. `ts.toMillis()` or `ts.toDate().toISOString()`) before passing in.
 */
function bindValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object') {
    const firestoreType = isFirestoreSpecialType(value);
    if (firestoreType) {
      throw new FiregraphError(
        `SQLite backend cannot bind a Firestore ${firestoreType} value — JSON serialization ` +
          `would silently drop fields and the resulting bind would never match a stored row. ` +
          `Convert to a primitive (e.g. \`ts.toMillis()\` for Timestamp) before filtering or ` +
          `updating.`,
        'INVALID_QUERY',
      );
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Validate `data.<key>` paths and deep `dataOps` path segments against the
 * subset of JSON keys that round-trip cleanly through SQLite's unquoted
 * JSON-path syntax (`$.<name>` style). The accepted shape —
 * `[A-Za-z_][\w-]*` — covers the overwhelmingly common case of code-style
 * identifiers (camel, snake, kebab) without forcing the SQL emitter to
 * quote/escape paths.
 *
 * Why not silently quote? Several characters (`.`, `[`, `]`, `"`) are
 * structural in SQLite's JSON path even inside the string after `$.` —
 * silently quoting would mean reads (`json_extract` for filters) and
 * writes (`json_set` / `json_remove` for `dataOps`) need symmetric quoting
 * at every call site, and any drift produces silent data corruption.
 * Failing loudly at compile time is the safer trade-off; users with exotic
 * keys can use `replaceNode` / `replaceEdge` (full-blob overwrite) instead.
 */
const JSON_PATH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validateJsonPathKey(key: string): void {
  if (key.length === 0) {
    throw new FiregraphError(
      'SQLite backend: empty JSON path component is not allowed',
      'INVALID_QUERY',
    );
  }
  if (!JSON_PATH_KEY_RE.test(key)) {
    throw new FiregraphError(
      `SQLite backend: data field path component "${key}" is not a safe JSON-path identifier. ` +
        `Allowed pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/. Use replaceNode/replaceEdge (full-data overwrite) ` +
        `for keys with reserved characters (whitespace, dots, brackets, quotes, etc.).`,
      'INVALID_QUERY',
    );
  }
}

function compileFilter(filter: QueryFilter, params: unknown[]): string {
  const { expr } = compileFieldRef(filter.field);

  switch (filter.op) {
    case '==':
      params.push(bindValue(filter.value));
      return `${expr} = ?`;
    case '!=':
      params.push(bindValue(filter.value));
      return `${expr} != ?`;
    case '<':
      params.push(bindValue(filter.value));
      return `${expr} < ?`;
    case '<=':
      params.push(bindValue(filter.value));
      return `${expr} <= ?`;
    case '>':
      params.push(bindValue(filter.value));
      return `${expr} > ?`;
    case '>=':
      params.push(bindValue(filter.value));
      return `${expr} >= ?`;
    case 'in': {
      const values = asArray(filter.value, 'in');
      const placeholders = values.map(() => '?').join(', ');
      for (const v of values) params.push(bindValue(v));
      return `${expr} IN (${placeholders})`;
    }
    case 'not-in': {
      const values = asArray(filter.value, 'not-in');
      const placeholders = values.map(() => '?').join(', ');
      for (const v of values) params.push(bindValue(v));
      return `${expr} NOT IN (${placeholders})`;
    }
    case 'array-contains': {
      params.push(bindValue(filter.value));
      return `EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value = ?)`;
    }
    case 'array-contains-any': {
      const values = asArray(filter.value, 'array-contains-any');
      const placeholders = values.map(() => '?').join(', ');
      for (const v of values) params.push(bindValue(v));
      return `EXISTS (SELECT 1 FROM json_each(${expr}) WHERE value IN (${placeholders}))`;
    }
    default:
      throw new FiregraphError(
        `SQLite backend does not support filter operator: ${String(filter.op)}`,
        'INVALID_QUERY',
      );
  }
}

function asArray(value: unknown, op: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FiregraphError(`Operator "${op}" requires a non-empty array value`, 'INVALID_QUERY');
  }
  return value;
}

function compileOrderBy(options: QueryOptions | undefined, _params: unknown[]): string {
  if (!options?.orderBy) return '';
  const { field, direction } = options.orderBy;
  const { expr } = compileFieldRef(field);
  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  return ` ORDER BY ${expr} ${dir}`;
}

function compileLimit(options: QueryOptions | undefined, params: unknown[]): string {
  if (options?.limit === undefined) return '';
  params.push(options.limit);
  return ` LIMIT ?`;
}

/**
 * SELECT all rows matching `filters` within `scope`. The scope filter is
 * always added as the leading predicate so the `(scope, …)` indexes apply.
 */
export function compileSelect(
  table: string,
  scope: string,
  filters: QueryFilter[],
  options?: QueryOptions,
): CompiledStatement {
  const params: unknown[] = [];
  const conditions: string[] = ['"scope" = ?'];
  params.push(scope);

  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }

  let sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${conditions.join(' AND ')}`;
  // ORDER BY parameters must come after WHERE parameters in the bind list.
  const orderClause = compileOrderBy(options, params);
  sql += orderClause;
  sql += compileLimit(options, params);

  return { sql, params };
}

/**
 * Cross-scope SELECT — equivalent to Firestore's collection group query.
 * Used by `findEdgesGlobal`.
 *
 * `scopeNameFilter`, when present, narrows the result to rows whose scope's
 * last materialized-path segment equals the given subgraph name (or to the
 * root rows when the name equals the table name itself, matching Firestore's
 * `db.collectionGroup(tableName)` semantics).
 */
export function compileSelectGlobal(
  table: string,
  filters: QueryFilter[],
  options?: QueryOptions,
  scopeNameFilter?: { name: string; isRoot: boolean },
): CompiledStatement {
  if (filters.length === 0) {
    throw new FiregraphError(
      'compileSelectGlobal requires at least one filter — refusing to issue an unbounded SELECT.',
      'INVALID_QUERY',
    );
  }

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (scopeNameFilter) {
    if (scopeNameFilter.isRoot) {
      conditions.push(`"scope" = ?`);
      params.push('');
    } else {
      conditions.push(`"scope" LIKE ? ESCAPE '\\'`);
      params.push(`%/${escapeLike(scopeNameFilter.name)}`);
    }
  }

  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }

  const sql =
    `SELECT * FROM ${quoteIdent(table)} WHERE ${conditions.join(' AND ')}` +
    compileOrderBy(options, params) +
    compileLimit(options, params);
  return { sql, params };
}

export function compileSelectByDocId(
  table: string,
  scope: string,
  docId: string,
): CompiledStatement {
  return {
    sql: `SELECT * FROM ${quoteIdent(table)} WHERE "scope" = ? AND "doc_id" = ? LIMIT 1`,
    params: [scope, docId],
  };
}

/**
 * Build the SQL expression that applies a list of `DataPathOp`s to an
 * existing JSON column reference (e.g. `"data"` or `COALESCE("data", '{}')`).
 *
 * Returns the full expression (already parenthesised where needed) and
 * pushes its bound parameters onto `params` in left-to-right order.
 *
 * Strategy:
 *   1. `json_remove(<base>, '$.a.b', '$.c', …)` strips delete-ops.
 *   2. `json_set(<#1>, '$.x.y', json(?), '$.z', json(?), …)` writes value-ops.
 *      `json(?)` ensures non-string values bind as JSON (objects, arrays,
 *      numbers, booleans, null).
 *
 * Returns `null` if there are no ops at all — caller handles separately.
 */
function compileDataOpsExpr(
  ops: readonly DataPathOp[],
  base: string,
  params: unknown[],
): string | null {
  if (ops.length === 0) return null;

  const deletes: DataPathOp[] = [];
  const sets: DataPathOp[] = [];
  for (const op of ops) (op.delete ? deletes : sets).push(op);

  let expr = base;

  if (deletes.length > 0) {
    const placeholders = deletes.map(() => '?').join(', ');
    expr = `json_remove(${expr}, ${placeholders})`;
    for (const op of deletes) {
      for (const seg of op.path) validateJsonPathKey(seg);
      params.push(`$.${op.path.join('.')}`);
    }
  }

  if (sets.length > 0) {
    const pieces = sets.map(() => '?, json(?)').join(', ');
    expr = `json_set(${expr}, ${pieces})`;
    for (const op of sets) {
      for (const seg of op.path) validateJsonPathKey(seg);
      params.push(`$.${op.path.join('.')}`);
      params.push(jsonBind(op.value));
    }
  }

  return expr;
}

/**
 * Bind a value as a JSON-serializable string for `json(?)` placeholders.
 * Firestore special types are rejected up front (see `bindValue`); this
 * variant exists because update ops can carry arrays / nested objects /
 * `null`, which must round-trip through JSON literally.
 */
function jsonBind(value: unknown): string {
  if (value === undefined) return 'null';
  if (value !== null && typeof value === 'object') {
    const firestoreType = isFirestoreSpecialType(value);
    if (firestoreType) {
      throw new FiregraphError(
        `SQLite backend cannot persist a Firestore ${firestoreType} value. ` +
          `Convert to a primitive before writing (e.g. \`ts.toMillis()\` for Timestamp).`,
        'INVALID_ARGUMENT',
      );
    }
  }
  return JSON.stringify(value);
}

/**
 * Compile a `setDoc(record, mode)` call into a single statement.
 *
 *   - `mode === 'replace'` — `INSERT OR REPLACE`. Every row column is
 *     overwritten; any pre-existing JSON keys not present in `record.data`
 *     are dropped.
 *   - `mode === 'merge'`   — `INSERT … ON CONFLICT(scope, doc_id) DO UPDATE
 *     SET …`. New rows insert the full record; existing rows have their
 *     `data` JSON deep-merged via the chained `json_set`/`json_remove`
 *     expression produced by `compileDataOpsExpr`. Sibling keys at every
 *     depth survive. Arrays and primitives are terminal (replaced as a
 *     unit), matching Firestore's `.set(..., { merge: true })` behaviour.
 *
 * `created_at` is re-stamped on every put — both modes use
 * `excluded.created_at` so the cross-backend contract matches today's
 * Firestore behaviour. (Future work: switch to insert-only createdAt; out
 * of scope for the merge-semantics fix.)
 */
export function compileSet(
  table: string,
  scope: string,
  docId: string,
  record: WritableRecord,
  nowMillis: number,
  mode: WriteMode,
): CompiledStatement {
  // Eager validation. Both branches below feed `record.data` to a raw
  // `JSON.stringify` for the INSERT path; flattenPatch only catches issues
  // on the merge UPDATE branch and only fires when there's a conflicting
  // row. Validating up front keeps first-insert and ON CONFLICT errors
  // identical, and rejects the DELETE_FIELD sentinel that JSON.stringify
  // would silently drop.
  assertJsonSafePayload(record.data, SQLITE_BACKEND_LABEL);
  if (mode === 'replace') {
    const sql = `INSERT OR REPLACE INTO ${quoteIdent(table)} (
      doc_id, scope, a_type, a_uid, axb_type, b_type, b_uid, data, v, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params: unknown[] = [
      docId,
      scope,
      record.aType,
      record.aUid,
      record.axbType,
      record.bType,
      record.bUid,
      JSON.stringify(record.data ?? {}),
      record.v ?? null,
      nowMillis,
      nowMillis,
    ];
    return { sql, params };
  }

  // Merge mode.
  const insertParams: unknown[] = [
    docId,
    scope,
    record.aType,
    record.aUid,
    record.axbType,
    record.bType,
    record.bUid,
    JSON.stringify(record.data ?? {}),
    record.v ?? null,
    nowMillis,
    nowMillis,
  ];

  // Translate record.data into deep-path ops, then build the merge expr.
  const ops = flattenPatch(record.data ?? {});
  const updateParams: unknown[] = [];
  const dataExpr =
    compileDataOpsExpr(ops, `COALESCE("data", '{}')`, updateParams) ?? `COALESCE("data", '{}')`;

  // `v` uses COALESCE(excluded.v, v) so an incoming record with `v=undefined`
  // (registry has no migrations, or stampWritableRecord didn't stamp) leaves
  // any previously-stamped `v` intact. Firestore's `set(record, {merge: true})`
  // omits the key when undefined and behaves the same way; SQLite must too.
  // Without COALESCE, `excluded.v` would be NULL and clobber a pre-existing
  // `v` — which silently breaks migration replay if migrations are removed
  // and later re-added to a type.
  const sql = `INSERT INTO ${quoteIdent(table)} (
      doc_id, scope, a_type, a_uid, axb_type, b_type, b_uid, data, v, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, doc_id) DO UPDATE SET
      "a_type" = excluded."a_type",
      "a_uid" = excluded."a_uid",
      "axb_type" = excluded."axb_type",
      "b_type" = excluded."b_type",
      "b_uid" = excluded."b_uid",
      "data" = ${dataExpr},
      "v" = COALESCE(excluded."v", "v"),
      "created_at" = excluded."created_at",
      "updated_at" = excluded."updated_at"`;

  return { sql, params: [...insertParams, ...updateParams] };
}

/**
 * Compile an `UpdatePayload` into a single UPDATE statement.
 *
 *   - `replaceData` overwrites the whole `data` JSON. (Used by migration
 *     write-back.)
 *   - `dataOps` deep-merges via chained `json_remove` / `json_set` —
 *     siblings at every nesting depth survive; arrays / primitives /
 *     Firestore special types are terminal; delete-ops use `json_remove`.
 *   - `v` is set when provided.
 *   - `updated_at` is always stamped.
 */
export function compileUpdate(
  table: string,
  scope: string,
  docId: string,
  update: UpdatePayload,
  nowMillis: number,
): CompiledStatement {
  assertUpdatePayloadExclusive(update);
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (update.replaceData) {
    assertJsonSafePayload(update.replaceData, SQLITE_BACKEND_LABEL);
    setClauses.push(`"data" = ?`);
    params.push(JSON.stringify(update.replaceData));
  } else if (update.dataOps && update.dataOps.length > 0) {
    const expr = compileDataOpsExpr(update.dataOps, `COALESCE("data", '{}')`, params);
    if (expr !== null) {
      setClauses.push(`"data" = ${expr}`);
    }
  }

  if (update.v !== undefined) {
    setClauses.push(`"v" = ?`);
    params.push(update.v);
  }

  setClauses.push(`"updated_at" = ?`);
  params.push(nowMillis);

  // WHERE params come last
  params.push(scope, docId);

  return {
    sql: `UPDATE ${quoteIdent(table)} SET ${setClauses.join(', ')} WHERE "scope" = ? AND "doc_id" = ?`,
    params,
  };
}

export function compileDelete(table: string, scope: string, docId: string): CompiledStatement {
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE "scope" = ? AND "doc_id" = ?`,
    params: [scope, docId],
  };
}

/**
 * Delete every row whose scope starts with `scopePrefix` followed by '/'.
 * Used by cascade delete to wipe all subgraphs nested under a node.
 *
 * The trailing '/' guard prevents `'a'` from matching `'ab'`. The exact-
 * match case (`scope = scopePrefix`) is intentionally NOT included: the
 * prefix passed in is always `<storageScope>/<uid>` (or just `<uid>` at
 * root), which is an odd-segment count, while every stored row's scope is
 * `''` (root) or an even-segment `<uid>/<name>[/…]` pair sequence — so
 * `scope = scopePrefix` can never match a real row.
 */
export function compileDeleteScopePrefix(table: string, scopePrefix: string): CompiledStatement {
  // SQLite LIKE escape: prefix could contain '%' or '_'. Escape with '\\'.
  const escaped = escapeLike(scopePrefix);
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE "scope" LIKE ? ESCAPE '\\'`,
    params: [`${escaped}/%`],
  };
}

/**
 * Count rows that `compileDeleteScopePrefix` would delete. Used by cascade
 * to report an accurate total in `CascadeResult.deleted` — the prefix-
 * delete is a single SQL statement and the executor surface doesn't expose
 * per-row counts. One extra index lookup per cascade is cheap relative to
 * the delete itself.
 */
export function compileCountScopePrefix(table: string, scopePrefix: string): CompiledStatement {
  const escaped = escapeLike(scopePrefix);
  return {
    sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE "scope" LIKE ? ESCAPE '\\'`,
    params: [`${escaped}/%`],
  };
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Convert a row returned by a SQLite driver into a `StoredGraphRecord`.
 * `created_at`/`updated_at` are wrapped in `GraphTimestampImpl` so they
 * present the same surface as Firestore's `Timestamp`.
 */
export function rowToRecord(row: Record<string, unknown>): StoredGraphRecord {
  const dataString = row.data as string | null;
  const data = dataString ? (JSON.parse(dataString) as Record<string, unknown>) : {};

  const createdMs = toMillis(row.created_at);
  const updatedMs = toMillis(row.updated_at);

  const record: Record<string, unknown> = {
    aType: row.a_type as string,
    aUid: row.a_uid as string,
    axbType: row.axb_type as string,
    bType: row.b_type as string,
    bUid: row.b_uid as string,
    data,
    createdAt: GraphTimestampImpl.fromMillis(createdMs) as unknown as GraphTimestamp,
    updatedAt: GraphTimestampImpl.fromMillis(updatedMs) as unknown as GraphTimestamp,
  };

  if (row.v !== null && row.v !== undefined) {
    record.v = Number(row.v);
  }
  return record as unknown as StoredGraphRecord;
}

function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}
