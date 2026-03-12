/**
 * Cross-graph edge resolution utilities.
 *
 * Provides path-scanning resolution for determining whether an edge's source
 * (aUid) is an ancestor node by checking if the UID appears in the Firestore
 * collection path.
 *
 * Firestore paths have a rigid alternating structure:
 *   collection / docId / collection / docId / collection
 *
 * Given a path like `graph/A/workspace/B/context`, segments at even indices
 * are collection names and odd indices are document IDs. When we find a UID
 * at an odd index, the collection containing that document is the path up to
 * (and including) the preceding even-index segment.
 */

/**
 * Parse a Firestore collection path and determine the collection path
 * where a given UID's document lives, if that UID is an ancestor in the path.
 *
 * @param collectionPath - The full Firestore collection path of the current client
 * @param uid - The UID to search for in the path
 * @returns The collection path containing the UID, or `null` if not found in the path
 *
 * @example
 * ```ts
 * // Path: graph/A/workspace/B/context
 * resolveAncestorCollection('graph/A/workspace/B/context', 'A')
 * // → 'graph'
 *
 * resolveAncestorCollection('graph/A/workspace/B/context', 'B')
 * // → 'graph/A/workspace'
 *
 * resolveAncestorCollection('graph/A/workspace/B/context', 'unknown')
 * // → null
 * ```
 */
export function resolveAncestorCollection(
  collectionPath: string,
  uid: string,
): string | null {
  const segments = collectionPath.split('/');

  // Walk odd-indexed segments (document IDs in Firestore's alternating path structure)
  for (let i = 1; i < segments.length; i += 2) {
    if (segments[i] === uid) {
      // The collection containing this doc is everything up to index i-1
      return segments.slice(0, i).join('/');
    }
  }

  return null;
}

/**
 * Check whether a UID belongs to an ancestor node by scanning the collection path.
 *
 * @param collectionPath - The full Firestore collection path of the current client
 * @param uid - The UID to check
 * @returns `true` if the UID appears as a document segment in the path
 */
export function isAncestorUid(
  collectionPath: string,
  uid: string,
): boolean {
  return resolveAncestorCollection(collectionPath, uid) !== null;
}
