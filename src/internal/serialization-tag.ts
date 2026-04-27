/**
 * Firegraph serialization tag — split from `src/serialization.ts` so it can
 * be imported from Workers-facing code without dragging in
 * `@google-cloud/firestore`.
 *
 * The full serialization module (with Timestamp/GeoPoint round-tripping)
 * lives one folder up because the sandbox migration pipeline needs it; the
 * write-plan helper only needs to recognise tagged objects to keep them
 * terminal during patch flattening, so it imports just the tag from here.
 */

/** Sentinel key used to tag serialized Firestore types. */
export const SERIALIZATION_TAG = '__firegraph_ser__' as const;

const KNOWN_TYPES = new Set(['Timestamp', 'GeoPoint', 'VectorValue', 'DocumentReference']);

/** Check if a value is a tagged serialized Firestore type. */
export function isTaggedValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const tag = (value as Record<string, unknown>)[SERIALIZATION_TAG];
  return typeof tag === 'string' && KNOWN_TYPES.has(tag);
}
