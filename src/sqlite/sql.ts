/**
 * Compile firegraph queries and writes into parameterized SQLite statements.
 *
 * The single-table SQLite schema mirrors the Firestore record envelope:
 * built-in fields (`aType`, `aUid`, etc.) are typed columns, and `data` is a
 * JSON string. `data.<key>` filter fields are translated to `json_extract`
 * expressions; built-in fields go straight to their column.
 */

import { FiregraphError } from '../errors.js';
import type { UpdatePayload, WritableRecord, WriteMode } from '../internal/backend.js';
import { NODE_RELATION } from '../internal/constants.js';
import {
  compileDataOpsExpr,
  isFirestoreSpecialType,
  validateJsonPathKey,
} from '../internal/sqlite-data-ops.js';
import { assertJsonSafePayload } from '../internal/sqlite-payload-guard.js';
import { FIELD_TO_COLUMN, quoteColumnAlias, quoteIdent } from '../internal/sqlite-schema.js';
import { assertUpdatePayloadExclusive, flattenPatch } from '../internal/write-plan.js';
import type { GraphTimestamp } from '../timestamp.js';
import { GraphTimestampImpl } from '../timestamp.js';
import type {
  AggregateSpec,
  ExpandParams,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';

const SQLITE_BACKEND_LABEL = 'shared-table SQLite';
const SQLITE_BACKEND_ERR_LABEL = 'SQLite backend';

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
      validateJsonPathKey(part, SQLITE_BACKEND_ERR_LABEL);
    }
    return { expr: `json_extract("data", '$.${suffix}')` };
  }
  if (field === 'data') {
    return { expr: `json_extract("data", '$')` };
  }
  throw new FiregraphError(`SQLite backend cannot resolve filter field: ${field}`, 'INVALID_QUERY');
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
 * Compile an aggregate query into a single `SELECT` statement.
 *
 * Each entry in `spec` becomes one aggregate function in the projection
 * list, aliased with the caller-supplied key. Field references reuse
 * `compileFieldRef` so dotted `data.*` paths are translated to
 * `json_extract` exactly the same way as in regular filters — including
 * the index-friendly inlined-path form.
 *
 * Numeric coercion: SUM/AVG/MIN/MAX cast `json_extract` results through
 * `CAST(... AS REAL)`. SQLite stores JSON as text, so without the cast a
 * numeric value extracted from the JSON column comes back as a string and
 * `MIN`/`MAX` would compare lexicographically (`"100" < "20"`). The cast
 * forces numeric semantics on those three; `COUNT(*)` is unaffected.
 *
 * Empty result handling matches the Firestore semantics surfaced by the
 * `runFirestoreAggregate` helper: SUM/MIN/MAX of an empty set returns 0
 * (resolving SQLite's `SUM(NULL) = NULL` to a clean number); AVG returns
 * `NaN` (mathematically undefined for empty input). The translation
 * happens at the JS layer in the SQLite backend so the SQL stays simple.
 */
export function compileAggregate(
  table: string,
  scope: string,
  spec: AggregateSpec,
  filters: QueryFilter[],
): { stmt: CompiledStatement; aliases: string[] } {
  const aliases = Object.keys(spec);
  if (aliases.length === 0) {
    throw new FiregraphError(
      'aggregate() requires at least one aggregation in the `aggregates` map.',
      'INVALID_QUERY',
    );
  }

  const projections: string[] = [];
  for (const alias of aliases) {
    const { op, field } = spec[alias];
    // Validate the alias as a JSON path key — same charset rule used for
    // dotted field references. This guards against accidental SQL
    // injection through caller-supplied alias names; aliases are inlined
    // (not parametrised) because SQL aliases can't be bound parameters.
    validateJsonPathKey(alias, SQLITE_BACKEND_ERR_LABEL);
    if (op === 'count') {
      // Reject a stray field — see `AggregateField` JSDoc for rationale.
      if (field !== undefined) {
        throw new FiregraphError(
          `Aggregate '${alias}' op 'count' must not specify a field — ` +
            `count operates on rows, not a column expression.`,
          'INVALID_QUERY',
        );
      }
      projections.push(`COUNT(*) AS ${quoteIdent(alias)}`);
      continue;
    }
    if (!field) {
      throw new FiregraphError(
        `Aggregate '${alias}' op '${op}' requires a field.`,
        'INVALID_QUERY',
      );
    }
    const { expr } = compileFieldRef(field);
    const numeric = `CAST(${expr} AS REAL)`;
    if (op === 'sum') projections.push(`SUM(${numeric}) AS ${quoteIdent(alias)}`);
    else if (op === 'avg') projections.push(`AVG(${numeric}) AS ${quoteIdent(alias)}`);
    else if (op === 'min') projections.push(`MIN(${numeric}) AS ${quoteIdent(alias)}`);
    else if (op === 'max') projections.push(`MAX(${numeric}) AS ${quoteIdent(alias)}`);
    else
      throw new FiregraphError(
        `SQLite backend does not support aggregate op: ${String(op)}`,
        'INVALID_QUERY',
      );
  }

  const params: unknown[] = [scope];
  const conditions: string[] = ['"scope" = ?'];
  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }

  const sql =
    `SELECT ${projections.join(', ')} ` +
    `FROM ${quoteIdent(table)} ` +
    `WHERE ${conditions.join(' AND ')}`;
  return { stmt: { sql, params }, aliases };
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
 * Discriminator for one projected column. The decoder uses this to recover
 * the JS-shape of the requested field from the SQL row.
 */
export type ProjectedColumnKind =
  /** Top-level TEXT column: `a_type`, `a_uid`, `axb_type`, `b_type`, `b_uid`. */
  | 'builtin-text'
  /** Top-level INTEGER column: `v`. */
  | 'builtin-int'
  /** Top-level INTEGER millis column: `created_at`, `updated_at`.
   *  Decoder wraps the millisecond value in `GraphTimestampImpl` so the
   *  output matches `findEdges` / `findNodes`. */
  | 'builtin-timestamp'
  /** Whole `data` JSON payload — emitted when the caller projects `'data'`
   *  literally. Decoder JSON.parses the column. */
  | 'data'
  /** Any `data.<path>` projection. The compiler emits a paired
   *  `json_extract(...)` value column and `json_type(...)` type column;
   *  the decoder uses the type to recover JSON-encoded objects/arrays as
   *  native JS while passing primitives through verbatim. */
  | 'json';

/** Per-column metadata returned alongside the compiled statement. The
 *  backend uses this to translate row -> projected JS object. */
export interface ProjectedColumnSpec {
  /** Original caller-supplied field name. Used as the alias in the SQL
   *  projection list AND as the key in the returned JS row. */
  field: string;
  /** Kind discriminator — see `ProjectedColumnKind`. */
  kind: ProjectedColumnKind;
  /** Alias of the paired `json_type(...)` column when `kind === 'json'`,
   *  otherwise undefined. Stored explicitly (rather than derived from
   *  `field`) so the compiler can use a guaranteed-unique sentinel that
   *  cannot collide with any caller-supplied select entry. */
  typeAlias?: string;
}

/**
 * Normalize a projection field name to the canonical form `compileFieldRef`
 * understands: built-ins stay as-is, `data` and `data.*` stay as-is, and a
 * bare `name` (with no dot and not in the built-in map) is rewritten to
 * `data.name`.
 *
 * Why bare names: the documented use case for `findEdgesProjected` is
 * "give me titles and dates for a list view", and the canonical example
 * (`select: ['title', 'date']`) reads naturally as bare names. Requiring
 * `'data.title'` would be portable to `WhereClause.field` but uglier in the
 * common case. The result row keys preserve the original form (`title`,
 * not `data.title`) so callers see what they asked for.
 */
function normalizeProjectionField(field: string): string {
  if (field in FIELD_TO_COLUMN) return field;
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Compile a `findEdgesProjected({ select })` call into a single SELECT
 * statement that returns only the requested fields.
 *
 * Shape:
 *
 *   SELECT
 *     <expr-1> AS "<field-1>", [json_type(...) AS "__fg_t_<idx>",]
 *     <expr-2> AS "<field-2>", [json_type(...) AS "__fg_t_<idx>",]
 *     ...
 *   FROM <table>
 *   WHERE "scope" = ? AND <filters>
 *   [ORDER BY ...]
 *   [LIMIT ?]
 *
 * For `data.*` fields the compiler also projects `json_type` so the
 * decoder can distinguish a stored string from a serialized object/array
 * (`json_extract` returns both as TEXT; `json_type` is the only reliable
 * disambiguator). The cost is one extra column per `data.*` field — all in
 * the same row, no extra round trip. The companion alias uses a positional
 * sentinel `__fg_t_<idx>` rather than `<field>__t` so it cannot collide
 * with a user-provided field literally named `<x>__t`.
 *
 * Duplicate entries in `select` are de-duped at compile time so the SQL
 * projection list carries one column per unique field. Order in the input
 * `select` is preserved (first occurrence wins).
 *
 * The compiler rejects an empty `select` (the client wrapper enforces this
 * too — both layers reject so a misuse caught by either surfaces a clean
 * `INVALID_QUERY`).
 */
export function compileFindEdgesProjected(
  table: string,
  scope: string,
  select: ReadonlyArray<string>,
  filters: QueryFilter[],
  options?: QueryOptions,
): { stmt: CompiledStatement; columns: ProjectedColumnSpec[] } {
  if (select.length === 0) {
    throw new FiregraphError(
      'compileFindEdgesProjected requires a non-empty select list — ' +
        'an empty projection has no SQL representation distinct from `findEdges`.',
      'INVALID_QUERY',
    );
  }

  // De-dupe while preserving first-occurrence order. Two entries that
  // differ only by normalization (e.g. `'title'` and `'data.title'`)
  // remain distinct so the result row carries both keys — that's the
  // caller's choice and we honour it.
  const seen = new Set<string>();
  const uniqueFields: string[] = [];
  for (const f of select) {
    if (!seen.has(f)) {
      seen.add(f);
      uniqueFields.push(f);
    }
  }

  const projections: string[] = [];
  const columns: ProjectedColumnSpec[] = [];
  for (let idx = 0; idx < uniqueFields.length; idx++) {
    const field = uniqueFields[idx]!;
    const canonical = normalizeProjectionField(field);
    const { expr } = compileFieldRef(canonical);
    // Alias is the caller-supplied field name verbatim — this is the key
    // the decoder reads back from each result row, and the contract is
    // "projection result is keyed by what the caller passed in". Use the
    // relaxed alias quoter so dotted paths like `data.detail.region` are
    // accepted (the strict `quoteIdent` is for table/column names only).
    const alias = quoteColumnAlias(field);
    projections.push(`${expr} AS ${alias}`);

    let kind: ProjectedColumnKind;
    let typeAliasName: string | undefined;
    if (canonical === 'data') {
      kind = 'data';
    } else if (canonical.startsWith('data.')) {
      kind = 'json';
      // Pair every json_extract with a json_type so the decoder can
      // recover objects/arrays. The paired column needs a guaranteed-
      // unique alias — `<field>__t` would collide if the caller projects
      // both `'foo'` and `'foo__t'` (legal user input). Use a positional
      // sentinel keyed by the field's de-duped index. The decoder reads
      // the type column off the same name we generated here, so we record
      // it in the column spec rather than reconstructing from the field.
      typeAliasName = `__fg_t_${idx}`;
      const typeAlias = quoteColumnAlias(typeAliasName);
      projections.push(`json_type("data", '$.${canonical.slice(5)}') AS ${typeAlias}`);
    } else {
      // Built-in field. Discriminate by column name so the decoder can
      // wrap timestamps in `GraphTimestampImpl` and coerce `v` to number.
      if (canonical === 'v') kind = 'builtin-int';
      else if (canonical === 'createdAt' || canonical === 'updatedAt') kind = 'builtin-timestamp';
      else kind = 'builtin-text';
    }
    columns.push({ field, kind, typeAlias: typeAliasName });
  }

  const params: unknown[] = [scope];
  const conditions: string[] = ['"scope" = ?'];
  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }

  let sql =
    `SELECT ${projections.join(', ')} ` +
    `FROM ${quoteIdent(table)} ` +
    `WHERE ${conditions.join(' AND ')}`;
  sql += compileOrderBy(options, params);
  sql += compileLimit(options, params);

  return { stmt: { sql, params }, columns };
}

/**
 * Decode one SQL row into the projected JS shape described by `columns`.
 *
 * Built-in TEXT/INTEGER columns pass through with light coercion (BigInt
 * to number for `v`); timestamps wrap into `GraphTimestampImpl`. `data.*`
 * fields use the paired `json_type` column to decide whether to JSON.parse
 * the value (objects and arrays come back as JSON-encoded TEXT from
 * `json_extract`; primitives come through with their native SQLite type).
 *
 * The function is exported so the SQLite and shared SQLite backends share
 * one decoder; both call this with the spec returned from
 * `compileFindEdgesProjected`.
 */
export function decodeProjectedRow(
  row: Record<string, unknown>,
  columns: ProjectedColumnSpec[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const raw = row[c.field];
    switch (c.kind) {
      case 'builtin-text':
        out[c.field] = raw === null || raw === undefined ? null : String(raw);
        break;
      case 'builtin-int':
        if (raw === null || raw === undefined) {
          // `v` is nullable in the schema; preserve null explicitly so
          // callers can distinguish "no version" from a numeric 0.
          out[c.field] = null;
        } else if (typeof raw === 'bigint') {
          out[c.field] = Number(raw);
        } else if (typeof raw === 'number') {
          out[c.field] = raw;
        } else {
          out[c.field] = Number(raw);
        }
        break;
      case 'builtin-timestamp': {
        const ms = toMillis(raw);
        out[c.field] = GraphTimestampImpl.fromMillis(ms) as unknown as GraphTimestamp;
        break;
      }
      case 'data':
        // Whole `data` payload — JSON.parse the column directly. Empty /
        // null defaults to `{}` for symmetry with `rowToRecord`.
        if (raw === null || raw === undefined || raw === '') {
          out[c.field] = {};
        } else {
          out[c.field] = JSON.parse(raw as string);
        }
        break;
      case 'json': {
        // Read the paired `json_type` companion column via the positional
        // sentinel recorded at compile time — the historical `<field>__t`
        // suffix would silently collide if the caller projected both
        // `'foo'` and `'foo__t'`.
        const t = row[c.typeAlias!] as string | null | undefined;
        if (raw === null || raw === undefined) {
          out[c.field] = null;
        } else if (t === 'object' || t === 'array') {
          // Stored object/array — `json_extract` returned a JSON-encoded
          // string. Re-parse to recover native JS shape.
          out[c.field] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } else if (t === 'integer' && typeof raw === 'bigint') {
          out[c.field] = Number(raw);
        } else {
          // text / real / true / false / null — pass through. SQLite's
          // driver already returns the native JS primitive type.
          out[c.field] = raw;
        }
        break;
      }
    }
  }
  return out;
}

/**
 * Compile an `expand()` fan-out into one SELECT statement.
 *
 * Shape (forward direction, with hydrate=false):
 *
 *   SELECT * FROM <table>
 *   WHERE "scope" = ? AND "axbType" = ? AND "aUid" IN (?, ?, …)
 *     [AND "aType" = ?] [AND "bType" = ?]
 *   [ORDER BY …]
 *   [LIMIT ?]
 *
 * The `IN ("aUid", …)` clause replaces the per-source `findEdges` loop
 * `traverse.ts` would otherwise issue, collapsing N round trips into one
 * regardless of how many sources the caller passes. Reverse direction
 * swaps the `IN` predicate to `"bUid"` and the optional `aType`/`bType`
 * filters cover the same dimensions either way.
 *
 * Hydration (`params.hydrate === true`) is **not** baked into this
 * function. The backend issues a follow-up `SELECT * WHERE "scope" = ?
 * AND "aUid" = "bUid" AND "axbType" = 'is' AND "bUid" IN (…)` against the
 * target-side UIDs and stitches the alignment in JS. A single-statement
 * JOIN is technically possible (edges and nodes share one table here)
 * but produces colliding column names and forces a manual aliased
 * row-decoder, with no measurable perf win on an in-process executor.
 * Two `exec()` calls keep the row-decoder shared with the rest of
 * `findEdges` / `findNodes`.
 *
 * Empty `sources` is an invariant violation here — the SQLite backend
 * intercepts that case before reaching the compiler and short-circuits
 * to an empty result. The compiler itself rejects it because an empty
 * `IN ()` clause is invalid SQL.
 */
export function compileExpand(
  table: string,
  scope: string,
  params: ExpandParams,
): CompiledStatement {
  if (params.sources.length === 0) {
    throw new FiregraphError(
      'compileExpand requires a non-empty sources list — empty IN () is invalid SQL. ' +
        'Callers should short-circuit empty input before reaching the compiler.',
      'INVALID_QUERY',
    );
  }
  const direction = params.direction ?? 'forward';
  // Column identifiers must use the on-disk snake_case names
  // (`a_uid`, `axb_type`, `b_uid`, …) — see `FIELD_TO_COLUMN` in
  // `src/internal/sqlite-schema.ts`. We resolve every column reference
  // through `compileFieldRef` so a future schema rename can't drift
  // between read-paths.
  const aUidCol = compileFieldRef('aUid').expr;
  const bUidCol = compileFieldRef('bUid').expr;
  const aTypeCol = compileFieldRef('aType').expr;
  const bTypeCol = compileFieldRef('bType').expr;
  const axbTypeCol = compileFieldRef('axbType').expr;
  const sourceColumn = direction === 'forward' ? aUidCol : bUidCol;

  const sqlParams: unknown[] = [scope, params.axbType];
  const conditions: string[] = ['"scope" = ?', `${axbTypeCol} = ?`];

  // The IN list. Source UIDs are not currently chunked — SQLite has no hard
  // cap on bound parameters (the default `SQLITE_MAX_VARIABLE_NUMBER` is
  // 32766 in modern builds), and traversal callers cap source-set growth
  // through `maxReads` long before any realistic IN-list size. If a caller
  // ever blows past that cap, the backend surfaces it as the underlying
  // SQLite error rather than failing silently.
  const placeholders = params.sources.map(() => '?').join(', ');
  conditions.push(`${sourceColumn} IN (${placeholders})`);
  for (const uid of params.sources) sqlParams.push(uid);

  if (params.aType !== undefined) {
    conditions.push(`${aTypeCol} = ?`);
    sqlParams.push(params.aType);
  }
  if (params.bType !== undefined) {
    conditions.push(`${bTypeCol} = ?`);
    sqlParams.push(params.bType);
  }

  // Exclude self-loop "node" rows. Without this, an `axbType = 'is'`
  // expand (which would only happen via an explicit hop on the node
  // relation) could match the node-as-self-loop rows. Forward expand
  // over a non-`is` axbType already excludes them via the axbType
  // predicate; this clause is a belt-and-braces guard for the corner
  // case where the caller explicitly asks for `axbType: 'is'`.
  if (params.axbType === NODE_RELATION) {
    conditions.push(`${aUidCol} != ${bUidCol}`);
  }

  let sql = `SELECT * FROM ${quoteIdent(table)} WHERE ${conditions.join(' AND ')}`;

  // ORDER BY uses the same `compileFieldRef` rules as `findEdges`, so
  // dotted `data.*` paths translate to `json_extract` and hit the same
  // expression indexes when present. Per-source-strict ordering would
  // require window functions; see `ExpandParams.limitPerSource` JSDoc
  // for the contract — this LIMIT is a soft total cap.
  if (params.orderBy) {
    sql += compileOrderBy({ orderBy: params.orderBy }, sqlParams);
  }

  if (params.limitPerSource !== undefined) {
    // Total cap = sources.length * limitPerSource. We multiply at compile
    // time so the bound parameter is a concrete integer; SQLite parses
    // `LIMIT ?` once and the executor binds it in flight.
    const totalLimit = params.sources.length * params.limitPerSource;
    sql += ` LIMIT ?`;
    sqlParams.push(totalLimit);
  }

  return { sql, params: sqlParams };
}

/**
 * Compile the hydration-pass query for `expand({ hydrate: true })`. Issues
 * one statement against the same table that fetches every node row whose
 * `bUid` is in the supplied set. The backend stitches alignment in JS
 * (a `Map<bUid, StoredGraphRecord>` keyed by the canonical node UID).
 *
 * Empty input is rejected for the same reason as `compileExpand`.
 */
export function compileExpandHydrate(
  table: string,
  scope: string,
  targetUids: string[],
): CompiledStatement {
  if (targetUids.length === 0) {
    throw new FiregraphError(
      'compileExpandHydrate requires a non-empty target list — empty IN () is invalid SQL.',
      'INVALID_QUERY',
    );
  }
  const placeholders = targetUids.map(() => '?').join(', ');
  const sqlParams: unknown[] = [scope, NODE_RELATION];
  for (const uid of targetUids) sqlParams.push(uid);

  // Resolve column refs via `compileFieldRef` — see `compileExpand` for
  // the schema-rename rationale.
  const aUidCol = compileFieldRef('aUid').expr;
  const bUidCol = compileFieldRef('bUid').expr;
  const axbTypeCol = compileFieldRef('axbType').expr;

  // Self-loop predicate (`a_uid = b_uid`) is what distinguishes a node
  // row from an edge row in the single-table schema. Without it, an
  // accidental `is`-typed edge (which firegraph forbids today, but the
  // schema doesn't enforce) could mask a real node row in the result.
  return {
    sql:
      `SELECT * FROM ${quoteIdent(table)} ` +
      `WHERE "scope" = ? AND ${axbTypeCol} = ? AND ${aUidCol} = ${bUidCol} AND ${bUidCol} IN (${placeholders})`,
    params: sqlParams,
  };
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
    compileDataOpsExpr(ops, `COALESCE("data", '{}')`, updateParams, SQLITE_BACKEND_ERR_LABEL) ??
    `COALESCE("data", '{}')`;

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
    for (const op of update.dataOps) {
      if (!op.delete) assertJsonSafePayload(op.value, SQLITE_BACKEND_LABEL);
    }
    const expr = compileDataOpsExpr(
      update.dataOps,
      `COALESCE("data", '{}')`,
      params,
      SQLITE_BACKEND_ERR_LABEL,
    );
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
 * Compile a server-side bulk DELETE — `query.dml` capability.
 *
 * Mirrors `compileSelect`'s WHERE construction (scope-leading predicate
 * + filter list) so any composite index that accelerates a `findEdges`
 * also accelerates the equivalent `bulkDelete`. Empty-filter callers (a
 * "delete everything in this scope" sweep) are accepted — the caller is
 * expected to have opted into a collection scan via `allowCollectionScan`
 * at the client layer; the SQL itself is the same shape regardless.
 */
export function compileBulkDelete(
  table: string,
  scope: string,
  filters: QueryFilter[],
): CompiledStatement {
  const params: unknown[] = [scope];
  const conditions: string[] = ['"scope" = ?'];
  for (const f of filters) {
    conditions.push(compileFilter(f, params));
  }
  return {
    sql: `DELETE FROM ${quoteIdent(table)} WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

/**
 * Compile a server-side bulk UPDATE — `query.dml` capability.
 *
 * The `patch.data` payload is deep-merged into each matching row's `data`
 * field via the same `flattenPatch` → `compileDataOpsExpr` pipeline that
 * single-row `compileUpdate` uses. Identifying columns (`aType`, `axbType`,
 * `aUid`, `bType`, `bUid`, `v`) are intentionally read-only through this
 * path — to relabel rows, delete and re-insert.
 *
 * Empty-patch (no leaves to merge) is rejected: a no-op UPDATE that only
 * touched `updated_at` would silently rewrite every matching row's
 * timestamp, which is almost never what the caller wants. If you want to
 * stamp without editing data, use `setDoc` with `'merge'`.
 */
export function compileBulkUpdate(
  table: string,
  scope: string,
  filters: QueryFilter[],
  patchData: Record<string, unknown>,
  nowMillis: number,
): CompiledStatement {
  const dataOps = flattenPatch(patchData);
  if (dataOps.length === 0) {
    throw new FiregraphError(
      'bulkUpdate() patch.data must contain at least one leaf — an empty patch ' +
        'would only rewrite `updated_at`, which is almost certainly a bug. ' +
        'Use `setDoc` with merge mode if you want to stamp without editing data.',
      'INVALID_QUERY',
    );
  }
  for (const op of dataOps) {
    if (!op.delete) assertJsonSafePayload(op.value, SQLITE_BACKEND_LABEL);
  }
  const setParams: unknown[] = [];
  const expr = compileDataOpsExpr(
    dataOps,
    `COALESCE("data", '{}')`,
    setParams,
    SQLITE_BACKEND_ERR_LABEL,
  );
  if (expr === null) {
    // `compileDataOpsExpr` only returns null when there's nothing to do —
    // we already guarded the empty-patch case above so this is unreachable
    // in practice, but the type system can't see that.
    throw new FiregraphError(
      'bulkUpdate() patch produced no SQL operations — internal invariant violated.',
      'INVALID_ARGUMENT',
    );
  }
  const setClauses: string[] = [`"data" = ${expr}`, `"updated_at" = ?`];
  setParams.push(nowMillis);

  // WHERE: scope + filters. Filter params follow the SET params in the
  // bind list — same ordering convention as `compileUpdate` /
  // `compileSelect`.
  const whereParams: unknown[] = [scope];
  const conditions: string[] = ['"scope" = ?'];
  for (const f of filters) {
    conditions.push(compileFilter(f, whereParams));
  }

  return {
    sql:
      `UPDATE ${quoteIdent(table)} SET ${setClauses.join(', ')} ` +
      `WHERE ${conditions.join(' AND ')}`,
    params: [...setParams, ...whereParams],
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
