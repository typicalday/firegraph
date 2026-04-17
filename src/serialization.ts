/**
 * Firestore-aware serialization for the sandbox migration pipeline.
 *
 * Firestore documents can contain special types (Timestamp, GeoPoint,
 * VectorValue, DocumentReference) that don't survive plain JSON
 * round-tripping. This module provides tagged serialization: Firestore
 * types are wrapped in tagged plain objects before JSON marshaling and
 * reconstructed after.
 *
 * Only used by the `defaultExecutor` sandbox path. Static migrations
 * (in-memory functions) receive raw Firestore objects directly.
 */

import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import { FieldValue, GeoPoint, Timestamp } from '@google-cloud/firestore';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel key used to tag serialized Firestore types. */
export const SERIALIZATION_TAG = '__firegraph_ser__' as const;

/** Known discriminator values for tagged types. */
const KNOWN_TYPES = new Set(['Timestamp', 'GeoPoint', 'VectorValue', 'DocumentReference']);

// One-time warning for DocumentReference deserialization without db
let _docRefWarned = false;

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Check if a value is a tagged serialized Firestore type. */
export function isTaggedValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const tag = (value as Record<string, unknown>)[SERIALIZATION_TAG];
  return typeof tag === 'string' && KNOWN_TYPES.has(tag);
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function isTimestamp(value: unknown): value is Timestamp {
  return value instanceof Timestamp;
}

function isGeoPoint(value: unknown): value is GeoPoint {
  return value instanceof GeoPoint;
}

function isDocumentReference(value: unknown): value is DocumentReference {
  // Duck-type check: DocumentReference has path (string) and firestore properties
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    v.firestore !== undefined &&
    typeof v.id === 'string' &&
    v.constructor?.name === 'DocumentReference'
  );
}

function isVectorValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.constructor?.name === 'VectorValue' && Array.isArray((v as Record<string, unknown>)._values)
  );
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Recursively walk a data object and replace Firestore types with tagged
 * plain objects suitable for JSON serialization.
 *
 * Returns a new object tree — the input is never mutated.
 */
export function serializeFirestoreTypes(data: Record<string, unknown>): Record<string, unknown> {
  return serializeValue(data) as Record<string, unknown>;
}

function serializeValue(value: unknown): unknown {
  // Primitives
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Firestore types (check before generic object/array)
  if (isTimestamp(value)) {
    return {
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }
  if (isGeoPoint(value)) {
    return {
      [SERIALIZATION_TAG]: 'GeoPoint',
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }
  if (isDocumentReference(value)) {
    return { [SERIALIZATION_TAG]: 'DocumentReference', path: (value as DocumentReference).path };
  }
  if (isVectorValue(value)) {
    // Prefer toArray() (public API) over _values (private internal property)
    const v = value as Record<string, unknown>;
    const values =
      typeof v.toArray === 'function' ? (v.toArray as () => number[])() : (v._values as number[]);
    return { [SERIALIZATION_TAG]: 'VectorValue', values: [...values] };
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  // Plain objects — recurse
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    result[key] = serializeValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

/**
 * Recursively walk a data object and reconstruct Firestore types from
 * tagged plain objects.
 *
 * @param data - The data to deserialize (typically from JSON.parse)
 * @param db - Optional Firestore instance for DocumentReference reconstruction.
 *   If not provided, tagged DocumentReferences are left as-is with a one-time warning.
 *
 * Returns a new object tree — the input is never mutated.
 */
export function deserializeFirestoreTypes(
  data: Record<string, unknown>,
  db?: Firestore,
): Record<string, unknown> {
  return deserializeValue(data, db) as Record<string, unknown>;
}

function deserializeValue(value: unknown, db?: Firestore): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Short-circuit for values that are already real Firestore types.
  // This makes deserializeFirestoreTypes idempotent — safe to call on data
  // that has already been deserialized (e.g., write-back after defaultExecutor
  // already reconstructed types, or static migrations that return raw types).
  if (
    isTimestamp(value) ||
    isGeoPoint(value) ||
    isDocumentReference(value) ||
    isVectorValue(value)
  ) {
    return value;
  }

  // Arrays
  if (Array.isArray(value)) {
    return value.map((v) => deserializeValue(v, db));
  }

  const obj = value as Record<string, unknown>;

  // Check for tagged Firestore type
  if (isTaggedValue(obj)) {
    const tag = obj[SERIALIZATION_TAG] as string;

    switch (tag) {
      case 'Timestamp':
        // Validate expected fields before reconstruction
        if (typeof obj.seconds !== 'number' || typeof obj.nanoseconds !== 'number') return obj;
        return new Timestamp(obj.seconds, obj.nanoseconds);

      case 'GeoPoint':
        if (typeof obj.latitude !== 'number' || typeof obj.longitude !== 'number') return obj;
        return new GeoPoint(obj.latitude, obj.longitude);

      case 'VectorValue':
        if (!Array.isArray(obj.values)) return obj;
        return FieldValue.vector(obj.values as number[]);

      case 'DocumentReference':
        if (typeof obj.path !== 'string') return obj;
        if (db) {
          return db.doc(obj.path);
        }
        // No db available — leave as tagged object with one-time warning
        if (!_docRefWarned) {
          _docRefWarned = true;
          console.warn(
            '[firegraph] DocumentReference encountered during migration deserialization ' +
              'but no Firestore instance available. The reference will remain as a tagged ' +
              'object with its path. Enable write-back for full reconstruction.',
          );
        }
        return obj;

      default:
        // Unknown tag — leave as-is (forward compatibility)
        return obj;
    }
  }

  // Plain object — recurse
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[key] = deserializeValue(obj[key], db);
  }
  return result;
}
