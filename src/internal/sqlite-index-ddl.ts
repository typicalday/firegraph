/**
 * Translator from `IndexSpec` to SQLite `CREATE INDEX` DDL.
 *
 * Shared between the DO SQLite backend (`src/cloudflare/schema.ts`) and the
 * legacy single-table SQLite backend (`src/internal/sqlite-schema.ts`). The
 * two backends differ only in:
 *
 *  1. Their field→column mapping (no `scope` column in the DO schema).
 *  2. Whether a fixed `scope` leading column is prepended to every index
 *     (legacy backend only — DO rows are scoped by DO-instance identity).
 *
 * Both differences are handled via the `fieldToColumn` and `leadingColumns`
 * options; the rest of the emission logic is identical.
 *
 * ## JSON path expression indexes
 *
 * Data-field specs (`data.foo`, `data.nested.bar`) compile to
 * `json_extract("data", '$.foo')` expression indexes. The JSON path
 * literal is inlined — not parametrized — so the SQLite query planner can
 * match the index against the expression emitted by the query compiler
 * (which also inlines the literal after this PR). Path components are
 * validated against a safe identifier pattern so inlining is not an
 * injection risk.
 *
 * ## Index naming
 *
 * Names are `{table}_idx_{hash}` where `hash` is a short FNV-1a of a
 * canonicalized spec. This keeps names stable across runs (so
 * `CREATE INDEX IF NOT EXISTS` is idempotent) and prevents collisions
 * between similar specs. The hash includes the field list, per-field
 * direction, and the `where` predicate.
 */

import { FiregraphError } from '../errors.js';
import type { IndexFieldSpec, IndexSpec } from '../types.js';

/**
 * Valid SQLite identifier pattern — used for table and column names.
 * Mirrors the validation in `sqlite-schema.ts` / `cloudflare/schema.ts` so
 * this module doesn't need to import one over the other.
 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Safe JSON path component. Must match `JSON_PATH_KEY_RE` in the SQLite
 * query compilers — an index is only useful if the query emits an
 * identical `json_extract` expression.
 */
const JSON_PATH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new FiregraphError(
      `Invalid SQL identifier in index DDL: ${name}. Must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
      'INVALID_INDEX',
    );
  }
  return `"${name}"`;
}

/**
 * FNV-1a 32-bit hash, returned as 8-char hex. Non-cryptographic;
 * used only to produce short, stable index names.
 */
function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function normalizeFields(
  fields: Array<string | IndexFieldSpec>,
): Array<{ path: string; desc: boolean }> {
  return fields.map((f) => {
    if (typeof f === 'string') return { path: f, desc: false };
    if (!f.path || typeof f.path !== 'string') {
      throw new FiregraphError(
        `IndexSpec field must be a string or { path: string, desc?: boolean }; got ${JSON.stringify(f)}`,
        'INVALID_INDEX',
      );
    }
    return { path: f.path, desc: !!f.desc };
  });
}

function specFingerprint(spec: IndexSpec, leadingColumns: string[]): string {
  // Canonical form: JSON of normalized fields + leading cols + where.
  // Leading columns are part of the fingerprint so the same spec under
  // two different backends gets distinct names (though in practice only
  // one backend compiles a given spec).
  const normalized = {
    lead: leadingColumns,
    fields: normalizeFields(spec.fields),
    where: spec.where ?? '',
  };
  return fnv1a32(JSON.stringify(normalized));
}

/**
 * Compile one field path to its SQLite column expression.
 *
 *  - Firegraph top-level fields (`aType`, `createdAt`, …) → mapped column.
 *  - `data.foo` / `data.foo.bar` → `json_extract("data", '$.foo.bar')`.
 *  - `data` alone → `json_extract("data", '$')`.
 */
function compileFieldExpr(path: string, fieldToColumn: Record<string, string>): string {
  const col = fieldToColumn[path];
  if (col) return quoteIdent(col);

  if (path === 'data') {
    return `json_extract("data", '$')`;
  }
  if (path.startsWith('data.')) {
    const suffix = path.slice(5);
    const parts = suffix.split('.');
    for (const part of parts) {
      if (!JSON_PATH_KEY_RE.test(part)) {
        throw new FiregraphError(
          `IndexSpec data path "${path}" has invalid component "${part}". ` +
            `Each component must match /^[A-Za-z_][A-Za-z0-9_-]*$/.`,
          'INVALID_INDEX',
        );
      }
    }
    // Inline the path literal (no parameter). Validated components above
    // are safe to embed — no quote or escape characters.
    return `json_extract("data", '$.${suffix}')`;
  }

  throw new FiregraphError(
    `IndexSpec field "${path}" is not a known firegraph field. ` +
      `Use a top-level field (aType, aUid, axbType, bType, bUid, createdAt, updatedAt, v) ` +
      `or a dotted data path like 'data.status'.`,
    'INVALID_INDEX',
  );
}

export interface SqliteIndexDDLOptions {
  /** Target table. */
  table: string;
  /** Map from firegraph field name to SQLite column name. */
  fieldToColumn: Record<string, string>;
  /**
   * Columns prepended to every index's field list (leading ASC). Used by
   * the legacy shared-table SQLite backend to lead every index with
   * `scope`, matching the predicate its query compiler emits.
   *
   * Identifier names only — no JSON paths or expressions.
   */
  leadingColumns?: string[];
}

/**
 * Emit the `CREATE INDEX IF NOT EXISTS` DDL for one `IndexSpec`.
 *
 * Returns a single SQL string. Name is deterministic (same spec → same
 * name across runs), so re-running the bootstrap is idempotent.
 */
export function buildIndexDDL(spec: IndexSpec, options: SqliteIndexDDLOptions): string {
  const { table, fieldToColumn, leadingColumns = [] } = options;

  if (!spec.fields || spec.fields.length === 0) {
    throw new FiregraphError('IndexSpec.fields must be a non-empty array', 'INVALID_INDEX');
  }

  const normalized = normalizeFields(spec.fields);
  const hash = specFingerprint(spec, leadingColumns);
  const indexName = `${table}_idx_${hash}`;

  const cols: string[] = [];
  for (const col of leadingColumns) {
    cols.push(quoteIdent(col));
  }
  for (const f of normalized) {
    const expr = compileFieldExpr(f.path, fieldToColumn);
    cols.push(f.desc ? `${expr} DESC` : expr);
  }

  let ddl = `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)} ON ${quoteIdent(table)}(${cols.join(', ')})`;

  if (spec.where) {
    // The predicate is inlined verbatim. It comes from library/app
    // configuration — never from user data — so we don't attempt to
    // parse, rewrite, or validate it. Callers authoring partial indexes
    // are responsible for writing a valid SQLite WHERE clause.
    ddl += ` WHERE ${spec.where}`;
  }

  return ddl;
}

/**
 * Deduplicate index specs by their deterministic fingerprint. Same spec
 * declared twice (e.g., by core preset + registry entry) collapses to a
 * single DDL statement.
 */
export function dedupeIndexSpecs(
  specs: ReadonlyArray<IndexSpec>,
  leadingColumns: string[] = [],
): IndexSpec[] {
  const seen = new Set<string>();
  const out: IndexSpec[] = [];
  for (const spec of specs) {
    const fp = specFingerprint(spec, leadingColumns);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(spec);
  }
  return out;
}
