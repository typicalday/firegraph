/**
 * Shared helpers for the `query.select` projection contract.
 *
 * The SQLite-shaped backends (`src/sqlite/sql.ts`,
 * `src/cloudflare/sql.ts`) carry their own `normalizeProjectionField`
 * implementations because they're entangled with `FIELD_TO_COLUMN` /
 * `DO_FIELD_TO_COLUMN`. The Firestore-shaped backends (`firestore-standard`,
 * `firestore-enterprise`) plus the `RoutingStorageBackend` pass-through use
 * the helpers below to keep the projection contract consistent across the
 * three runtimes:
 *
 *   - bare names → `data.<name>`
 *   - `'data'` and `'data.*'` → as-is
 *   - top-level envelope fields (`aType`, `aUid`, `axbType`, `bType`,
 *     `bUid`, `createdAt`, `updatedAt`, `v`) → as-is
 *
 * The set diverges from `BUILTIN_FIELDS` in `internal/constants.ts` — that
 * one is the queryable-filter set and does not include `v`. Projection
 * accepts `v` because it is a top-level envelope field that the user may
 * want to read for diagnostics.
 */

const PROJECTION_BUILTIN_FIELDS: ReadonlySet<string> = new Set([
  'aType',
  'aUid',
  'axbType',
  'bType',
  'bUid',
  'createdAt',
  'updatedAt',
  'v',
]);

/**
 * Rewrite a caller-supplied projection field to the canonical form the
 * Firestore-shaped backends consume. See file header for the rules.
 */
export function normalizeFirestoreProjectionField(field: string): string {
  if (PROJECTION_BUILTIN_FIELDS.has(field)) return field;
  if (field === 'data' || field.startsWith('data.')) return field;
  return `data.${field}`;
}

/**
 * Read a (possibly dotted) path out of a partial document. Used by the
 * Firestore-shaped backends to translate `doc.data()` into the projected JS
 * shape: each row in the result is keyed by the *original* field as the
 * caller supplied it, and the value is whatever lives at the canonical
 * path inside the partial document Firestore returns.
 *
 * Missing path segments resolve to `null` (not `undefined`) to match the
 * SQLite-shaped backends, where `json_extract` returns SQL NULL for an
 * absent JSON path — the decoder surfaces that as `null`. Aligning here
 * means a consumer iterating over `Object.entries(row)` sees the same
 * shape across SQLite/DO/Firestore: every requested field is present in
 * the row object, and absent values are explicitly `null`. If we returned
 * `undefined`, Firestore rows would silently lose absent keys when
 * serialized through `JSON.stringify`, breaking that contract.
 */
export function readProjectionPath(
  obj: Record<string, unknown> | undefined | null,
  path: string,
): unknown {
  if (obj === undefined || obj === null) return null;
  const raw = !path.includes('.')
    ? obj[path]
    : (() => {
        const parts = path.split('.');
        let cur: unknown = obj;
        for (const part of parts) {
          if (cur === undefined || cur === null) return undefined;
          if (typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[part];
        }
        return cur;
      })();
  return raw === undefined ? null : raw;
}
