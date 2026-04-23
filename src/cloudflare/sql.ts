/**
 * SQL compilation for the DO SQLite backend.
 *
 * Every `FiregraphDO` instance owns one SQLite database holding exactly one
 * subgraph's triples — there is no `scope` column and no scope discriminator
 * on any statement. Contrast with `src/internal/sqlite-sql.ts`, which
 * carries a scope prefix on every read and write for the legacy shared-table
 * D1/DO SQLite backend.
 *
 * Filter compilation, JSON-path validation, and value binding mirror the
 * legacy module so the query planner (`src/query.ts`) emits the same
 * `QueryFilter[]` shape regardless of backend.
 */

import { FiregraphError } from '../errors.js';
import type { UpdatePayload, WritableRecord } from '../internal/backend.js';
import type { GraphTimestamp } from '../timestamp.js';
import { GraphTimestampImpl } from '../timestamp.js';
import type { QueryFilter, QueryOptions, StoredGraphRecord } from '../types.js';
import { DO_FIELD_TO_COLUMN, quoteDOIdent } from './schema.js';

/**
 * Wire representation of a stored record across the DO RPC boundary.
 *
 * Durable Object RPC uses structured clone, which preserves plain data but
 * drops user-defined class prototypes — a `GraphTimestampImpl` from the DO
 * arrives at the client as a plain `{seconds, nanoseconds}` object without
 * its `toMillis()` / `toDate()` methods. To avoid silent `.toMillis is not a
 * function` crashes downstream, records returned from DO RPC carry the two
 * timestamps as plain millisecond numbers in `createdAtMs` / `updatedAtMs`;
 * the client-side backend rewraps them as `GraphTimestampImpl` via
 * `hydrateDORecord` before handing the record to the GraphClient.
 */
export interface DORecordWire {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  v?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CompiledStatement {
  sql: string;
  params: unknown[];
}

// ---------------------------------------------------------------------------
// Filter compilation
// ---------------------------------------------------------------------------

/**
 * Translate a firegraph filter field to either a column reference or a
 * `json_extract("data", '$.<path>')` expression. Built-in fields go
 * straight to their column; `data.<key>[.<key>…]` and bare `data` are
 * projected through `json_extract` with the JSON path **inlined as a
 * string literal** — not parametrized.
 *
 * Inlining matters: SQLite's query planner matches an expression index
 * (`CREATE INDEX … ON tbl(json_extract("data", '$.status'))`) against
 * *textually identical* expressions in the WHERE clause. `json_extract(
 * "data", ?)` parametrizes the path and would never hit the index, even
 * though it evaluates to the same value. Inlining here makes the
 * expression literal in the SQL, which is what the index builder in
 * `sqlite-index-ddl.ts` also emits.
 *
 * Inlining is safe: each path component is validated against
 * `JSON_PATH_KEY_RE` (`/^[A-Za-z_][A-Za-z0-9_-]*$/`) before it reaches
 * this function — the pattern excludes every character SQLite would
 * treat as syntax (quote, backslash, dot, bracket, whitespace), so
 * string concatenation can't produce injection.
 */
function compileFieldRef(field: string): { expr: string } {
  const column = DO_FIELD_TO_COLUMN[field];
  if (column) {
    return { expr: quoteDOIdent(column) };
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
  throw new FiregraphError(
    `DO SQLite backend cannot resolve filter field: ${field}`,
    'INVALID_QUERY',
  );
}

/**
 * Firestore special types that don't survive `JSON.stringify`: they either
 * have non-enumerable accessors (`Timestamp.seconds`) or rely on class
 * identity the JSON representation drops. Detection is by `constructor.name`
 * to keep this module free of `@google-cloud/firestore` imports (bundle
 * pollution matters on Workers — see tests/unit/bundle-pollution.test.ts).
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
 * Coerce a JS filter/update value into a SQLite-bindable primitive. Firestore
 * special types are rejected loudly because `JSON.stringify` would emit
 * garbage that silently fails to match any stored row. Callers should
 * project to a primitive (e.g. `ts.toMillis()`) before passing in.
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
        `DO SQLite backend cannot bind a Firestore ${firestoreType} value — JSON serialization ` +
          `would silently drop fields and the resulting bind would never match a stored row. ` +
          `Convert to a primitive (e.g. \`ts.toMillis()\` for Timestamp) before filtering or updating.`,
        'INVALID_QUERY',
      );
    }
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Identifiers accepted in `data.<key>` paths and `dataFields` keys.
 *
 * The allowed shape (`/^[A-Za-z_][A-Za-z0-9_-]*$/`) covers code-style
 * identifiers (camel, snake, kebab). Silently quoting exotic keys would
 * require symmetric quoting at every read/write call site; any drift
 * produces silent data corruption. Failing loudly at compile time is
 * safer — users with exotic keys can use `replaceData` instead of
 * `dataFields`.
 */
const JSON_PATH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validateJsonPathKey(key: string): void {
  if (key.length === 0) {
    throw new FiregraphError(
      'DO SQLite backend: empty JSON path component is not allowed',
      'INVALID_QUERY',
    );
  }
  if (!JSON_PATH_KEY_RE.test(key)) {
    throw new FiregraphError(
      `DO SQLite backend: data field path component "${key}" is not a safe JSON-path identifier. ` +
        `Allowed pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/. Use replaceData (full-data overwrite) ` +
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
        `DO SQLite backend does not support filter operator: ${String(filter.op)}`,
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

// ---------------------------------------------------------------------------
// Statement compilation
// ---------------------------------------------------------------------------

/**
 * SELECT rows matching `filters`. No scope predicate — every row in this
 * DO's database belongs to the same subgraph.
 */
export function compileDOSelect(
  table: string,
  filters: QueryFilter[],
  options?: QueryOptions,
): CompiledStatement {
  const params: unknown[] = [];
  const conditions: string[] = [];

  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  let sql = `SELECT * FROM ${quoteDOIdent(table)}${where}`;
  sql += compileOrderBy(options, params);
  sql += compileLimit(options, params);

  return { sql, params };
}

/**
 * SELECT a single row by doc_id. `doc_id` is the PK so this is an O(1)
 * index lookup.
 */
export function compileDOSelectByDocId(table: string, docId: string): CompiledStatement {
  return {
    sql: `SELECT * FROM ${quoteDOIdent(table)} WHERE "doc_id" = ? LIMIT 1`,
    params: [docId],
  };
}

/**
 * INSERT OR REPLACE — `setDoc` semantics. Full row replacement keyed by
 * `doc_id`.
 */
export function compileDOSet(
  table: string,
  docId: string,
  record: WritableRecord,
  nowMillis: number,
): CompiledStatement {
  const sql = `INSERT OR REPLACE INTO ${quoteDOIdent(table)} (
    doc_id, a_type, a_uid, axb_type, b_type, b_uid, data, v, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params: unknown[] = [
    docId,
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

/**
 * Compile an `UpdatePayload` into a single UPDATE statement. Same rules as
 * the legacy backend: `replaceData` overwrites the whole blob; `dataFields`
 * shallow-merges via `json_set(data, '$.k', v, …)`; `v` is stamped when
 * provided; `updated_at` is always stamped.
 */
export function compileDOUpdate(
  table: string,
  docId: string,
  update: UpdatePayload,
  nowMillis: number,
): CompiledStatement {
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (update.replaceData) {
    setClauses.push(`"data" = ?`);
    params.push(JSON.stringify(update.replaceData));
  } else if (update.dataFields && Object.keys(update.dataFields).length > 0) {
    const entries = Object.entries(update.dataFields);
    const pathArgs = entries.map(() => `?, ?`).join(', ');
    setClauses.push(`"data" = json_set(COALESCE("data", '{}'), ${pathArgs})`);
    for (const [k, v] of entries) {
      validateJsonPathKey(k);
      params.push(`$.${k}`);
      params.push(bindValue(v));
    }
  }

  if (update.v !== undefined) {
    setClauses.push(`"v" = ?`);
    params.push(update.v);
  }

  setClauses.push(`"updated_at" = ?`);
  params.push(nowMillis);

  params.push(docId);

  return {
    sql: `UPDATE ${quoteDOIdent(table)} SET ${setClauses.join(', ')} WHERE "doc_id" = ?`,
    params,
  };
}

export function compileDODelete(table: string, docId: string): CompiledStatement {
  return {
    sql: `DELETE FROM ${quoteDOIdent(table)} WHERE "doc_id" = ?`,
    params: [docId],
  };
}

/**
 * DELETE every row in the table. Used when tearing down an entire subgraph
 * DO as part of cascade — the caller discovers the set of DOs to wipe via
 * registry topology (phase 2) and instructs each DO to clear itself.
 */
export function compileDODeleteAll(table: string): CompiledStatement {
  return {
    sql: `DELETE FROM ${quoteDOIdent(table)}`,
    params: [],
  };
}

// ---------------------------------------------------------------------------
// Row -> record (wire-safe) and hydration
// ---------------------------------------------------------------------------

/**
 * Convert a SQLite row into a `DORecordWire` — the wire-safe shape returned
 * across DO RPC. Timestamps stay as plain millisecond numbers here; the
 * client-side backend calls `hydrateDORecord` to rewrap them as
 * `GraphTimestampImpl` before surfacing the record to the GraphClient.
 *
 * Splitting serialization from hydration like this is what lets the DO
 * return values safely through structured clone without pretending its
 * output is a full `StoredGraphRecord`.
 */
export function rowToDORecord(row: Record<string, unknown>): DORecordWire {
  const dataString = row.data as string | null;
  const data = dataString ? (JSON.parse(dataString) as Record<string, unknown>) : {};

  const createdAtMs = toMillis(row.created_at);
  const updatedAtMs = toMillis(row.updated_at);

  const record: DORecordWire = {
    aType: row.a_type as string,
    aUid: row.a_uid as string,
    axbType: row.axb_type as string,
    bType: row.b_type as string,
    bUid: row.b_uid as string,
    data,
    createdAtMs,
    updatedAtMs,
  };

  if (row.v !== null && row.v !== undefined) {
    record.v = Number(row.v);
  }
  return record;
}

/**
 * Rewrap a `DORecordWire` as a full `StoredGraphRecord`, restoring
 * `GraphTimestampImpl` instances from the wire-level millisecond numbers.
 * Called by `DORPCBackend` on every record returned from a DO RPC.
 */
export function hydrateDORecord(wire: DORecordWire): StoredGraphRecord {
  const record: Record<string, unknown> = {
    aType: wire.aType,
    aUid: wire.aUid,
    axbType: wire.axbType,
    bType: wire.bType,
    bUid: wire.bUid,
    data: wire.data,
    createdAt: GraphTimestampImpl.fromMillis(wire.createdAtMs) as unknown as GraphTimestamp,
    updatedAt: GraphTimestampImpl.fromMillis(wire.updatedAtMs) as unknown as GraphTimestamp,
  };
  if (wire.v !== undefined) {
    record.v = wire.v;
  }
  return record as unknown as StoredGraphRecord;
}

/**
 * Coerce a timestamp column value to a plain millis number. The schema types
 * `created_at` / `updated_at` as `INTEGER NOT NULL` so the column should
 * always arrive as a number (or possibly a bigint on some SQLite bindings),
 * but a string row value from SQLite (e.g. BigInt.toString fallback) is also
 * accepted. Anything else indicates a corrupt row — throw loudly rather than
 * silently returning 0, which would quietly mask the bug on every read.
 */
function toMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new FiregraphError(
    `DO SQLite row has non-numeric timestamp column: ${typeof value} (${String(value)})`,
    'INVALID_QUERY',
  );
}
