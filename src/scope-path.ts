/**
 * Storage-scope path utilities — materialized-path parsing helpers for the
 * SQLite backend's `storageScope` string and for any custom backend that
 * adopts the same encoding (e.g. a cross-DO routing layer that uses
 * `storageScope` as a Durable Object name).
 *
 * **Storage-scope** (as produced by `SqliteBackendImpl`) interleaves parent
 * UIDs with subgraph names:
 *
 * ```
 * ''                                  // root
 * 'A/memories'                        // g.subgraph(A, 'memories')
 * 'A/memories/B/context'              // .subgraph(B, 'context') on the above
 * ```
 *
 * The structure is the same as a Firestore collection path with the
 * collection/doc segments reordered: each pair is `<uid>/<name>`, where
 * `<uid>` is a node UID in the parent scope and `<name>` is the subgraph
 * name. Use these helpers to decode that structure when building cross-
 * backend routers (see `createRoutingBackend`).
 *
 * For Firestore paths (which begin with a collection segment), use
 * `resolveAncestorCollection` / `isAncestorUid` from `./cross-graph.js`.
 */

/**
 * One segment of a materialized-path storage-scope — a `(uid, name)` pair
 * produced by one `subgraph(uid, name)` call.
 */
export interface StorageScopeSegment {
  /** Parent node UID at the enclosing scope. */
  uid: string;
  /** Subgraph name chosen by the caller (e.g. `'memories'`). */
  name: string;
}

/**
 * Parse a materialized-path storage-scope into its `(uid, name)` pairs.
 *
 * Returns `[]` for the root (`''`). Throws `Error('INVALID_SCOPE_PATH')`
 * when the string has an odd number of segments (a corrupt path — every
 * level contributes exactly two segments) or when any segment is empty.
 *
 * @example
 * ```ts
 * parseStorageScope('');                         // []
 * parseStorageScope('A/memories');               // [{ uid: 'A', name: 'memories' }]
 * parseStorageScope('A/memories/B/context');     // [{ uid: 'A', name: 'memories' }, { uid: 'B', name: 'context' }]
 * ```
 */
export function parseStorageScope(scope: string): StorageScopeSegment[] {
  if (scope === '') return [];
  const parts = scope.split('/');
  if (parts.length % 2 !== 0) {
    throw new Error(
      `INVALID_SCOPE_PATH: storage-scope "${scope}" has an odd number of segments; ` +
        'expected interleaved <uid>/<name> pairs.',
    );
  }
  const out: StorageScopeSegment[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const uid = parts[i];
    const name = parts[i + 1];
    if (!uid || !name) {
      throw new Error(
        `INVALID_SCOPE_PATH: storage-scope "${scope}" contains an empty segment at position ${i}.`,
      );
    }
    out.push({ uid, name });
  }
  return out;
}

/**
 * Resolve the ancestor **storage-scope** at which a given UID's node lives,
 * by scanning a materialized-path storage-scope for that UID.
 *
 * Mirrors `resolveAncestorCollection()` from `./cross-graph.js` for
 * Firestore paths, but operates on `storageScope` (no leading collection
 * segment — segments are `<uid>/<name>` pairs).
 *
 * @returns The storage-scope at which the UID's node was added via
 *   `subgraph(uid, _)`, or `null` if the UID does not appear at a UID
 *   position in the path.
 *
 * @example
 * ```ts
 * // Scope: 'A/memories/B/context'
 * resolveAncestorScope('A/memories/B/context', 'A');  // ''    (A was added at root)
 * resolveAncestorScope('A/memories/B/context', 'B');  // 'A/memories'
 * resolveAncestorScope('A/memories/B/context', 'X');  // null
 * ```
 */
export function resolveAncestorScope(storageScope: string, uid: string): string | null {
  if (!uid) return null;
  if (storageScope === '') return null;
  const parts = storageScope.split('/');
  // UID positions are even indices (0, 2, 4, …); names are at odd indices.
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === uid) {
      return i === 0 ? '' : parts.slice(0, i).join('/');
    }
  }
  return null;
}

/**
 * Boolean shorthand for `resolveAncestorScope(scope, uid) !== null`.
 */
export function isAncestorScopeUid(storageScope: string, uid: string): boolean {
  return resolveAncestorScope(storageScope, uid) !== null;
}

/**
 * Join a parent storage-scope with a new `(uid, name)` pair, producing the
 * storage-scope that `backend.subgraph(uid, name)` would use internally.
 *
 * This is the inverse of `parseStorageScope`'s per-segment semantics and is
 * useful when computing DO names / shard keys from the router callback.
 */
export function appendStorageScope(parentScope: string, uid: string, name: string): string {
  if (!uid || uid.includes('/')) {
    throw new Error(
      `INVALID_SCOPE_PATH: uid must be non-empty and must not contain "/": got "${uid}".`,
    );
  }
  if (!name || name.includes('/')) {
    throw new Error(
      `INVALID_SCOPE_PATH: name must be non-empty and must not contain "/": got "${name}".`,
    );
  }
  return parentScope ? `${parentScope}/${uid}/${name}` : `${uid}/${name}`;
}
