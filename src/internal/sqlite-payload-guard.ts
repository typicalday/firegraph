/**
 * Shared eager-validation helper for SQLite-style backends
 * (`internal/sqlite-sql.ts` and `cloudflare/sql.ts`).
 *
 * Both backends serialise `record.data` (and `update.replaceData`) as a raw
 * JSON blob via `JSON.stringify`. Two classes of value silently corrupt that
 * representation and the cross-backend contract:
 *
 *   1. **Firestore special types** (`Timestamp`, `GeoPoint`, `VectorValue`,
 *      `DocumentReference`, `FieldValue`). They have non-enumerable accessors
 *      or rely on class identity that JSON drops, so they round-trip as `{}`
 *      or garbage. Callers must convert to primitives before writing.
 *   2. **`DELETE_FIELD` sentinel.** A `Symbol` is invisible to
 *      `JSON.stringify`. If a caller embeds the sentinel in a `replaceNode`
 *      payload or in a fresh-insert (no existing row), the field would
 *      silently disappear instead of erroring loudly the way it does for the
 *      `dataOps` path — so we reject it eagerly here.
 *   3. **Tagged serialization payloads** (`__firegraph_ser__`). These are the
 *      sandbox migration boundary marshalling form. They are valid inside
 *      Firestore (the Firestore backend re-hydrates them via
 *      `deserializeFirestoreTypes`), but on SQLite they would persist as
 *      opaque tagged objects that no downstream reader knows how to interpret.
 *      Reject them at the boundary so the failure is loud.
 *
 * The Firestore backend does NOT call this — it accepts those types natively
 * and `deserializeFirestoreTypes` rebuilds tagged values into real Firestore
 * objects on its own write path.
 *
 * Detection avoids `instanceof` so this module stays free of
 * `@google-cloud/firestore`. Constructor-name + duck-type matches the
 * approach used by `bindValue`/`jsonBind` elsewhere in the SQLite compilers.
 */

import { FiregraphError } from '../errors.js';
import { SERIALIZATION_TAG } from './serialization-tag.js';
import { isDeleteSentinel } from './write-plan.js';

const FIRESTORE_TYPE_NAMES = new Set([
  'Timestamp',
  'GeoPoint',
  'VectorValue',
  'DocumentReference',
  'FieldValue',
]);

/**
 * Walk `data` and throw on any value that the SQLite-style raw-JSON
 * persistence path can't faithfully serialise. `label` distinguishes the
 * caller in error messages (e.g. `'shared-table SQLite'` vs `'DO SQLite'`).
 *
 * Plain objects recurse. Arrays recurse element-wise. Primitives, `null`,
 * and `undefined` are accepted (mirroring how `flattenPatch` treats them
 * during the merge path).
 */
export function assertJsonSafePayload(data: unknown, label: string): void {
  walk(data, [], label);
}

function walk(node: unknown, path: readonly string[], label: string): void {
  if (node === null || node === undefined) return;
  if (isDeleteSentinel(node)) {
    throw new FiregraphError(
      `${label} backend cannot persist a deleteField() sentinel inside a ` +
        `full-data payload (replaceNode/replaceEdge or first-insert). The ` +
        `sentinel is only valid inside an updateNode/updateEdge dataOps patch. ` +
        `Path: ${formatPath(path)}.`,
      'INVALID_ARGUMENT',
    );
  }
  const t = typeof node;
  if (t !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walk(node[i], [...path, String(i)], label);
    }
    return;
  }
  // Tagged serialization payload — reject loudly. SQLite has no Timestamp
  // class to rebuild it into, so persisting the tag would make the value
  // unreadable.
  const obj = node as Record<string, unknown>;
  if (typeof obj[SERIALIZATION_TAG] === 'string') {
    throw new FiregraphError(
      `${label} backend cannot persist a tagged Firestore-type payload ` +
        `(\`${SERIALIZATION_TAG}: ${String(obj[SERIALIZATION_TAG])}\`). These ` +
        `appear in migration sandbox output and are valid only on the ` +
        `Firestore backend. Convert to a primitive before writing. ` +
        `Path: ${formatPath(path)}.`,
      'INVALID_ARGUMENT',
    );
  }
  // Class instances: reject Firestore special types loudly; reject every
  // other class instance generically (Map, Set, Date are caller's
  // responsibility to convert — Date is allowed in filter binds via
  // `bindValue` but not as a stored payload value because JSON.stringify
  // produces a string, not a real Date).
  const proto = Object.getPrototypeOf(node);
  if (proto !== null && proto !== Object.prototype) {
    const ctor = (node as { constructor?: { name?: string } }).constructor;
    const ctorName = ctor && typeof ctor.name === 'string' ? ctor.name : '<anonymous>';
    if (FIRESTORE_TYPE_NAMES.has(ctorName)) {
      throw new FiregraphError(
        `${label} backend cannot persist a Firestore ${ctorName} value. ` +
          `Convert to a primitive before writing (e.g. \`ts.toMillis()\` for ` +
          `Timestamp, \`{lat,lng}\` for GeoPoint). Path: ${formatPath(path)}.`,
        'INVALID_ARGUMENT',
      );
    }
    // Accept Date as an alias for its epoch-ms — it round-trips as an ISO
    // string via JSON.stringify, which the caller chose; not our place to
    // reject. Same for Buffer / typed arrays — they'll JSON-serialize as
    // best they can. Reject only opaque exotic instances that JSON drops.
    if (node instanceof Date) return;
    throw new FiregraphError(
      `${label} backend cannot persist a class instance of type ${ctorName}. ` +
        `Only plain objects, arrays, and primitives round-trip safely through ` +
        `JSON storage. Path: ${formatPath(path)}.`,
      'INVALID_ARGUMENT',
    );
  }
  for (const key of Object.keys(obj)) {
    walk(obj[key], [...path, key], label);
  }
}

function formatPath(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.map((p) => JSON.stringify(p)).join(' > ');
}
