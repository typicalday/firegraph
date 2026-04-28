/**
 * Write-plan helper — flattens partial-update payloads into a list of
 * deep-path operations every backend can execute identically.
 *
 * Background: firegraph used to ship two write semantics that quietly
 * disagreed about depth.
 *   - `putNode`/`putEdge` did a full document replace.
 *   - `updateNode`/`updateEdge` did a one-level shallow merge: top-level
 *     keys were preserved, but nested objects were replaced wholesale.
 *
 * Both behaviours dropped sibling keys silently. The 0.12 contract is that
 * `put*` and `update*` deep-merge by default (sibling keys at any depth
 * survive); `replace*` is the explicit escape hatch.
 *
 * `flattenPatch` walks a partial-update payload and emits one
 * {@link DataPathOp} per terminal value. Plain objects recurse; arrays,
 * primitives, Firestore special types, and tagged firegraph-serialization
 * objects are terminal (replaced as a unit). `undefined` values are
 * skipped; `null` is preserved as a real `null` write; the
 * {@link DELETE_FIELD} sentinel marks a field for removal.
 *
 * The output is deliberately backend-agnostic. Each backend translates ops
 * into its native dialect:
 *   - Firestore: dotted field path → `data.a.b.c` for `update()`.
 *   - SQLite / DO SQLite: `json_set(data, '$.a.b.c', ?)` /
 *     `json_remove(data, '$.a.b.c')`.
 */

import { isTaggedValue, SERIALIZATION_TAG } from './serialization-tag.js';

// ---------------------------------------------------------------------------
// Public sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel returned by {@link deleteField}. Treated by all backends as
 * "remove this field from the stored document".
 *
 * Equivalent to Firestore's `FieldValue.delete()`, but works for SQLite
 * backends too. Use inside `updateNode`/`updateEdge` payloads.
 */
export const DELETE_FIELD: unique symbol = Symbol.for('firegraph.deleteField');
export type DeleteSentinel = typeof DELETE_FIELD;

/**
 * Returns the firegraph delete sentinel. Place this anywhere in an
 * `updateNode`/`updateEdge` payload to remove the corresponding field.
 *
 * ```ts
 * await client.updateNode('tour', uid, {
 *   attrs: { obsoleteFlag: deleteField() },
 * });
 * ```
 */
export function deleteField(): DeleteSentinel {
  return DELETE_FIELD;
}

/** Type guard for the delete sentinel. */
export function isDeleteSentinel(value: unknown): value is DeleteSentinel {
  return value === DELETE_FIELD;
}

// ---------------------------------------------------------------------------
// Terminal-detection helpers
// ---------------------------------------------------------------------------

const FIRESTORE_TERMINAL_CTOR = new Set([
  'Timestamp',
  'GeoPoint',
  'VectorValue',
  'DocumentReference',
  'FieldValue',
  'NumericIncrementTransform',
  'ArrayUnionTransform',
  'ArrayRemoveTransform',
  'ServerTimestampTransform',
  'DeleteTransform',
]);

/**
 * Should this value be written as a single terminal op (no recursion)?
 *
 * Plain JS objects (constructor === Object, or no prototype) are recursed.
 * Everything else — arrays, primitives, class instances, Firestore special
 * types, tagged serialization payloads — is terminal.
 */
export function isTerminalValue(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t !== 'object') return true;
  if (Array.isArray(value)) return true;
  // Tagged serialization payloads carry the SERIALIZATION_TAG sentinel and
  // should be persisted whole — never split into per-field ops.
  if (isTaggedValue(value)) return true;
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return false;
  // Class instances — Firestore types or anything else exotic.
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  if (ctor && typeof ctor.name === 'string' && FIRESTORE_TERMINAL_CTOR.has(ctor.name)) return true;
  // Unknown class instance: treat as terminal. Recursing into a class
  // instance is almost always wrong (Map, Set, Date, Buffer...).
  return true;
}

// ---------------------------------------------------------------------------
// Core type
// ---------------------------------------------------------------------------

/**
 * Single terminal write operation produced by {@link flattenPatch}.
 *
 * `path` is a non-empty array of plain object keys. `value` is the value to
 * write; ignored when `delete` is `true`. Arrays / primitives / Firestore
 * special types appear here as whole terminal values.
 */
export interface DataPathOp {
  path: readonly string[];
  value: unknown;
  delete: boolean;
}

// ---------------------------------------------------------------------------
// Path-segment validation
// ---------------------------------------------------------------------------

/**
 * Object keys that are safe to embed in SQLite `json_set`/`json_remove`
 * paths. The SQLite backend uses an allowlist regex too — keep these in
 * sync (see `JSON_PATH_KEY_RE` in `internal/sqlite-sql.ts` and
 * `cloudflare/sql.ts`).
 *
 * Allows: ASCII letters, digits, `_`, `-`. Must start with a letter or
 * underscore. This rejects keys containing dots, brackets, quotes, or
 * non-ASCII characters that could break path parsing or be used to
 * inject into the path expression.
 */
const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Mutual-exclusion guard for {@link UpdatePayload}. The two branches of the
 * shape — `dataOps` (deep-merge) and `replaceData` (full replace) — are
 * structurally incompatible: combining them would tell the backend to
 * simultaneously merge AND wipe, and the three backends disagree on which
 * wins. This helper centralises the runtime check so all three backends
 * trip the same error.
 *
 * Imported as a runtime check from `firestore-backend`, `sqlite-sql`, and
 * `cloudflare/sql`. Backend authors implementing the public `StorageBackend`
 * contract should call it too.
 */
export function assertUpdatePayloadExclusive(update: {
  dataOps?: unknown;
  replaceData?: unknown;
}): void {
  if (update.replaceData !== undefined && update.dataOps !== undefined) {
    throw new Error(
      'firegraph: UpdatePayload cannot specify both `replaceData` and `dataOps`. ' +
        'Use one or the other — `replaceData` is the migration-write-back form, ' +
        '`dataOps` is the standard partial-update form.',
    );
  }
}

/**
 * Reject `DELETE_FIELD` sentinels in payloads where field deletion isn't a
 * meaningful operation: full-document replace (`replaceNode`/`replaceEdge`)
 * and the merge-default put surface (`putNode`/`putEdge`).
 *
 * Why both:
 *   - In **replace**, the entire `data` field is overwritten. A delete
 *     sentinel in that payload either silently disappears (Firestore drops
 *     the Symbol during `.set()` serialization) or produces an empty SQLite
 *     `json_remove` no-op, depending on backend. Either way the caller's
 *     intent — "remove field X" — is lost. Use `updateNode` instead.
 *   - In **put** (merge mode), behaviour diverges across backends today:
 *     SQLite's flattenPatch emits a real delete op, but Firestore's
 *     `.set(..., {merge: true})` silently drops the Symbol. Until that's
 *     fixed end-to-end, the safest contract is to reject sentinels at the
 *     entry point and steer callers to `updateNode`.
 *
 * The walk mirrors `flattenPatch`: plain objects recurse, everything else
 * is terminal. Tagged serialization payloads short-circuit so we don't
 * recurse into the `__firegraph_ser__` envelope.
 */
export function assertNoDeleteSentinels(data: unknown, callerLabel: string): void {
  walkForDeleteSentinels(data, [], { kind: 'root' }, ({ path }) => {
    const where = path.length === 0 ? '<root>' : path.map((p) => JSON.stringify(p)).join(' > ');
    throw new Error(
      `firegraph: ${callerLabel} payload contains a deleteField() sentinel at ${where}. ` +
        `deleteField() is only valid inside updateNode/updateEdge — full-data ` +
        `writes (put*, replace*) cannot delete individual fields. Use updateNode ` +
        `with a deleteField() value, or omit the field from the replace payload.`,
    );
  });
}

type SentinelParent = { kind: 'root' } | { kind: 'object' } | { kind: 'array'; index: number };

function walkForDeleteSentinels(
  node: unknown,
  path: readonly string[],
  parent: SentinelParent,
  visit: (ctx: { path: readonly string[]; parent: SentinelParent }) => void,
): void {
  if (node === null || node === undefined) return;
  if (isDeleteSentinel(node)) {
    visit({ path, parent });
    return;
  }
  if (typeof node !== 'object') return;
  if (isTaggedValue(node)) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      walkForDeleteSentinels(node[i], [...path, String(i)], { kind: 'array', index: i }, visit);
    }
    return;
  }
  const proto = Object.getPrototypeOf(node);
  if (proto !== null && proto !== Object.prototype) return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    walkForDeleteSentinels(obj[key], [...path, key], { kind: 'object' }, visit);
  }
}

/** Throws if any path segment in the patch is unsafe for SQLite paths. */
export function assertSafePath(path: readonly string[]): void {
  for (const seg of path) {
    if (!SAFE_KEY_RE.test(seg)) {
      throw new Error(
        `firegraph: unsafe object key ${JSON.stringify(seg)} at path ${path
          .map((p) => JSON.stringify(p))
          .join(' > ')}. Keys used inside update payloads must match ` +
          `/^[A-Za-z_][A-Za-z0-9_-]*$/ so they can be embedded safely in ` +
          `SQLite JSON paths.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// flattenPatch
// ---------------------------------------------------------------------------

/**
 * Flatten a partial-update payload into a list of terminal {@link DataPathOp}s.
 *
 * Rules:
 *   - Plain objects (no prototype or `Object.prototype`) recurse — each
 *     key becomes another path segment.
 *   - Arrays are terminal: writing `{tags: ['a']}` overwrites the whole
 *     `tags` array. Element-wise array merging is intentionally NOT
 *     supported — it's almost never what callers actually want, and
 *     Firestore `arrayUnion`/`arrayRemove` give precise semantics when
 *     they are.
 *   - `undefined` values are skipped (no op generated). Use
 *     {@link deleteField} if you actually want to remove a field.
 *   - `null` is preserved verbatim — emits a terminal op with `value: null`.
 *   - {@link DELETE_FIELD} produces an op with `delete: true`.
 *   - Firestore special types and tagged serialization payloads are terminal.
 *   - Class instances are terminal.
 *
 * Throws if any object key on the recursion path is unsafe (see
 * {@link assertSafePath}).
 */
export function flattenPatch(data: Record<string, unknown>): DataPathOp[] {
  const ops: DataPathOp[] = [];
  walk(data, [], ops);
  return ops;
}

function assertNoDeleteSentinelsInArrayValue(
  arr: readonly unknown[],
  arrayPath: readonly string[],
): void {
  walkForDeleteSentinels(arr, arrayPath, { kind: 'root' }, ({ parent }) => {
    const arrayPathStr =
      arrayPath.length === 0 ? '<root>' : arrayPath.map((p) => JSON.stringify(p)).join(' > ');
    if (parent.kind === 'array') {
      throw new Error(
        `firegraph: deleteField() sentinel at index ${parent.index} inside an array at ` +
          `path ${arrayPathStr}. Arrays are ` +
          `terminal in update payloads (replaced as a unit), so the sentinel ` +
          `would be silently dropped by JSON serialization. To remove the ` +
          `field entirely, pass deleteField() in place of the whole array.`,
      );
    }
    throw new Error(
      `firegraph: deleteField() sentinel inside an array element at ` +
        `path ${arrayPathStr}. ` +
        `Arrays are terminal in update payloads — the sentinel would ` +
        `be silently dropped by JSON serialization.`,
    );
  });
}

function walk(node: unknown, path: string[], out: DataPathOp[]): void {
  // Caller guarantees the root is a plain object; this branch only
  // matters for recursion.
  if (node === undefined) return;
  if (isDeleteSentinel(node)) {
    if (path.length === 0) {
      throw new Error('firegraph: deleteField() cannot be the entire update payload.');
    }
    assertSafePath(path);
    out.push({ path: [...path], value: undefined, delete: true });
    return;
  }
  if (isTerminalValue(node)) {
    if (path.length === 0) {
      // `null` / array / primitive at the root is illegal — patches must
      // describe per-key changes.
      throw new Error(
        'firegraph: update payload must be a plain object. Got ' +
          (node === null ? 'null' : Array.isArray(node) ? 'array' : typeof node) +
          '.',
      );
    }
    // A DELETE_FIELD sentinel embedded inside an array (which is terminal
    // and replaced as a unit) would silently disappear: JSON.stringify drops
    // Symbols, and Firestore's serializer does likewise. Reject loudly so
    // the divergence between "user wrote a delete" and "field stayed put"
    // can't happen.
    if (Array.isArray(node)) {
      assertNoDeleteSentinelsInArrayValue(node, path);
    }
    assertSafePath(path);
    out.push({ path: [...path], value: node, delete: false });
    return;
  }
  // Plain object: recurse into its own enumerable keys.
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    // Empty object at non-root: emit terminal op so an empty object can
    // be written explicitly when the caller really wants one. Skip at
    // the root — no-op patches should produce no ops.
    if (path.length > 0) {
      assertSafePath(path);
      out.push({ path: [...path], value: {}, delete: false });
    }
    return;
  }
  for (const key of keys) {
    if (key === SERIALIZATION_TAG) {
      const where =
        path.length === 0 ? '<root>' : path.map((p) => JSON.stringify(p)).join(' > ');
      throw new Error(
        `firegraph: update payload contains a literal \`${SERIALIZATION_TAG}\` key at ` +
          `${where}. That key is reserved for firegraph's serialization envelope and ` +
          `cannot appear on a plain object in user data. Use a different field name, ` +
          `or pass a recognized tagged value through replaceNode/replaceEdge instead.`,
      );
    }
    walk(obj[key], [...path, key], out);
  }
}

