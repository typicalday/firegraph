/**
 * Shared `dataOps` SQL compilation helpers used by both SQLite-style backends
 * (`internal/sqlite-sql.ts` for the shared-table backend and `cloudflare/sql.ts`
 * for the per-DO backend).
 *
 * The two backends differ in identifier quoting and scope handling, but the
 * `data` column lives in JSON in both, the deep-merge / replace contract is
 * identical, and the `json_set` / `json_remove` expression they emit for a
 * `DataPathOp[]` is byte-for-byte the same. Lifting the helpers here keeps
 * that shape in one place — the comment in `cloudflare/sql.ts` used to read
 * "keep them in sync"; this module is what they keep in sync against.
 *
 * The helpers take a `backendLabel` parameter so error messages still
 * distinguish `"SQLite backend"` (shared-table) from `"DO SQLite backend"`
 * (per-Durable-Object). Identifier quoting is the caller's job — the helpers
 * here only emit JSON-path expressions against an opaque `base` argument,
 * never bare column names.
 */

import { FiregraphError } from '../errors.js';
import type { DataPathOp } from './write-plan.js';

/**
 * Constructor names of Firestore special types that don't survive a plain
 * `JSON.stringify` round-trip — they have non-enumerable accessors (e.g.
 * `Timestamp.seconds`) or class identity that JSON loses. Detection is by
 * `constructor.name` to keep this module dependency-free (importing
 * `@google-cloud/firestore` here would pollute the Cloudflare Workers bundle —
 * see tests/unit/bundle-pollution.test.ts).
 */
export const FIRESTORE_TYPE_NAMES = new Set([
  'Timestamp',
  'GeoPoint',
  'VectorValue',
  'DocumentReference',
  'FieldValue',
]);

export function isFirestoreSpecialType(value: object): string | null {
  const ctorName = (value as { constructor?: { name?: string } }).constructor?.name;
  if (ctorName && FIRESTORE_TYPE_NAMES.has(ctorName)) return ctorName;
  return null;
}

/**
 * Identifiers accepted in `data.<key>` paths and `dataOps` path segments.
 * The pattern (`/^[A-Za-z_][A-Za-z0-9_-]*$/`) covers code-style identifiers
 * (camel, snake, kebab). Silently quoting exotic keys would require symmetric
 * quoting at every read/write call site; any drift produces silent data
 * corruption. Failing loudly at compile time is safer — users with exotic
 * keys can use `replaceNode` / `replaceEdge` (full-data overwrite) instead.
 */
export const JSON_PATH_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function validateJsonPathKey(key: string, backendLabel: string): void {
  if (key.length === 0) {
    throw new FiregraphError(
      `${backendLabel}: empty JSON path component is not allowed`,
      'INVALID_QUERY',
    );
  }
  if (!JSON_PATH_KEY_RE.test(key)) {
    throw new FiregraphError(
      `${backendLabel}: data field path component "${key}" is not a safe JSON-path identifier. ` +
        `Allowed pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/. Use replaceNode/replaceEdge (full-data overwrite) ` +
        `for keys with reserved characters (whitespace, dots, brackets, quotes, etc.).`,
      'INVALID_QUERY',
    );
  }
}

/**
 * Build a SQLite JSON path (`$."a"."b"."c"`) from `DataPathOp` segments.
 *
 * Each segment is wrapped as a double-quoted JSON-path label via
 * `JSON.stringify`, which quotes the key and backslash-escapes any embedded
 * double-quotes or backslashes — exactly the escaping SQLite's JSON path
 * parser accepts for quoted labels (verified on SQLite 3.53). Quoting every
 * segment means digit-leading keys (`4f9Kq_2bN`), hyphens, dots, brackets,
 * and whitespace all address the literal key rather than being reparsed as
 * path syntax. Dots stay inside the quotes, so `{ 'a.b': 1 }` writes the
 * single key `"a.b"` instead of a nested `a → b`.
 *
 * The result is always bound as a SQL parameter (never interpolated), so
 * there is no injection surface — the quoting here is purely about producing
 * a path string SQLite parses as the intended literal key.
 */
export function buildJsonPath(segments: readonly string[]): string {
  return '$' + segments.map((seg) => '.' + JSON.stringify(seg)).join('');
}

/**
 * Bind a value as a JSON-serializable string for `json(?)` placeholders in
 * the compiled `json_set` expression. `assertJsonSafePayload` already runs
 * eagerly at the write boundary, so the Firestore-special-type rejection
 * here is defense-in-depth — left in place per the team's preference for
 * symmetric guards across the SQLite compilers.
 */
export function jsonBind(value: unknown, backendLabel: string): string {
  if (value === undefined) return 'null';
  if (value !== null && typeof value === 'object') {
    const firestoreType = isFirestoreSpecialType(value);
    if (firestoreType) {
      throw new FiregraphError(
        `${backendLabel} cannot persist a Firestore ${firestoreType} value. ` +
          `Convert to a primitive before writing (e.g. \`ts.toMillis()\` for Timestamp).`,
        'INVALID_ARGUMENT',
      );
    }
  }
  return JSON.stringify(value);
}

/**
 * Build the SQL expression that applies a list of `DataPathOp`s onto an
 * existing JSON column reference (e.g. `"data"` or `COALESCE("data", '{}')`).
 *
 * Returns the full expression (already parenthesised where needed) and pushes
 * the bound parameters onto `params` in left-to-right order. Returns `null`
 * when there are no ops at all — the caller picks a fallback expression.
 *
 * Strategy:
 *   1. `json_remove(<base>, '$.a.b', '$.c', …)` strips delete-ops.
 *   2. `json_set(<#1>, '$.x.y', json(?), '$.z', json(?), …)` writes value-ops.
 *      `json(?)` ensures non-string values bind as JSON (objects, arrays,
 *      numbers, booleans, null).
 */
export function compileDataOpsExpr(
  ops: readonly DataPathOp[],
  base: string,
  params: unknown[],
  backendLabel: string,
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
      params.push(buildJsonPath(op.path));
    }
  }

  if (sets.length > 0) {
    const pieces = sets.map(() => '?, json(?)').join(', ');
    expr = `json_set(${expr}, ${pieces})`;
    for (const op of sets) {
      params.push(buildJsonPath(op.path));
      params.push(jsonBind(op.value, backendLabel));
    }
  }

  return expr;
}
