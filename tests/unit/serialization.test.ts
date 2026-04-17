import type { Firestore } from '@google-cloud/firestore';
import { FieldValue, GeoPoint, Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  deserializeFirestoreTypes,
  isTaggedValue,
  SERIALIZATION_TAG,
  serializeFirestoreTypes,
} from '../../src/serialization.js';

// ---------------------------------------------------------------------------
// isTaggedValue
// ---------------------------------------------------------------------------

describe('isTaggedValue', () => {
  it('returns false for null', () => {
    expect(isTaggedValue(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isTaggedValue(42)).toBe(false);
    expect(isTaggedValue('hello')).toBe(false);
    expect(isTaggedValue(true)).toBe(false);
    expect(isTaggedValue(undefined)).toBe(false);
  });

  it('returns false for plain objects', () => {
    expect(isTaggedValue({ foo: 'bar' })).toBe(false);
  });

  it('returns true for known tagged types', () => {
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 'Timestamp', seconds: 0, nanoseconds: 0 })).toBe(
      true,
    );
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 'GeoPoint', latitude: 0, longitude: 0 })).toBe(
      true,
    );
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 'VectorValue', values: [] })).toBe(true);
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 'DocumentReference', path: 'a/b' })).toBe(true);
  });

  it('returns false for unknown discriminator', () => {
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 'UnknownType' })).toBe(false);
  });

  it('returns false when tag value is not a string', () => {
    expect(isTaggedValue({ [SERIALIZATION_TAG]: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// serializeFirestoreTypes
// ---------------------------------------------------------------------------

describe('serializeFirestoreTypes', () => {
  it('passes plain data through unchanged', () => {
    const data = { name: 'test', count: 42, active: true, tags: ['a', 'b'] };
    expect(serializeFirestoreTypes(data)).toEqual(data);
  });

  it('does not mutate the input', () => {
    const ts = new Timestamp(1000, 500);
    const data = { createdAt: ts };
    const original = { ...data };
    serializeFirestoreTypes(data);
    expect(data.createdAt).toBe(original.createdAt);
  });

  it('serializes Timestamp', () => {
    const data = { createdAt: new Timestamp(1700000000, 123456789) };
    const result = serializeFirestoreTypes(data);
    expect(result.createdAt).toEqual({
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 1700000000,
      nanoseconds: 123456789,
    });
  });

  it('serializes GeoPoint', () => {
    const data = { location: new GeoPoint(37.7749, -122.4194) };
    const result = serializeFirestoreTypes(data);
    expect(result.location).toEqual({
      [SERIALIZATION_TAG]: 'GeoPoint',
      latitude: 37.7749,
      longitude: -122.4194,
    });
  });

  it('serializes VectorValue', () => {
    const vector = FieldValue.vector([1.0, 2.0, 3.0]);
    const data = { embedding: vector };
    const result = serializeFirestoreTypes(data);
    expect(result.embedding).toEqual({
      [SERIALIZATION_TAG]: 'VectorValue',
      values: [1.0, 2.0, 3.0],
    });
  });

  it('serializes nested Firestore types', () => {
    const data = {
      meta: {
        timestamps: {
          created: new Timestamp(1000, 0),
          updated: new Timestamp(2000, 0),
        },
      },
    };
    const result = serializeFirestoreTypes(data);
    const meta = result.meta as Record<string, unknown>;
    const timestamps = meta.timestamps as Record<string, unknown>;
    expect(timestamps.created).toEqual({
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 1000,
      nanoseconds: 0,
    });
    expect(timestamps.updated).toEqual({
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 2000,
      nanoseconds: 0,
    });
  });

  it('serializes Firestore types inside arrays', () => {
    const data = {
      points: [new GeoPoint(1, 2), new GeoPoint(3, 4)],
    };
    const result = serializeFirestoreTypes(data);
    expect(result.points).toEqual([
      { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 1, longitude: 2 },
      { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 3, longitude: 4 },
    ]);
  });

  it('handles null and undefined values', () => {
    const data = { a: null, b: undefined, c: 'hello' };
    const result = serializeFirestoreTypes(data);
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe('hello');
  });

  it('handles mixed plain and Firestore data', () => {
    const data = {
      name: 'test',
      count: 42,
      createdAt: new Timestamp(1000, 0),
      location: new GeoPoint(10, 20),
      tags: ['a', 'b'],
    };
    const result = serializeFirestoreTypes(data);
    expect(result.name).toBe('test');
    expect(result.count).toBe(42);
    expect(result.tags).toEqual(['a', 'b']);
    expect(result.createdAt).toEqual({
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 1000,
      nanoseconds: 0,
    });
    expect(result.location).toEqual({
      [SERIALIZATION_TAG]: 'GeoPoint',
      latitude: 10,
      longitude: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// deserializeFirestoreTypes
// ---------------------------------------------------------------------------

describe('deserializeFirestoreTypes', () => {
  it('passes plain data through unchanged', () => {
    const data = { name: 'test', count: 42, active: true };
    expect(deserializeFirestoreTypes(data)).toEqual(data);
  });

  it('does not mutate the input', () => {
    const data = {
      createdAt: { [SERIALIZATION_TAG]: 'Timestamp', seconds: 1000, nanoseconds: 0 },
    };
    const originalTag = (data.createdAt as Record<string, unknown>)[SERIALIZATION_TAG];
    deserializeFirestoreTypes(data);
    expect((data.createdAt as Record<string, unknown>)[SERIALIZATION_TAG]).toBe(originalTag);
  });

  it('deserializes Timestamp', () => {
    const data = {
      createdAt: { [SERIALIZATION_TAG]: 'Timestamp', seconds: 1700000000, nanoseconds: 123456789 },
    };
    const result = deserializeFirestoreTypes(data);
    expect(result.createdAt).toBeInstanceOf(Timestamp);
    const ts = result.createdAt as Timestamp;
    expect(ts.seconds).toBe(1700000000);
    expect(ts.nanoseconds).toBe(123456789);
  });

  it('deserializes GeoPoint', () => {
    const data = {
      location: { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 37.7749, longitude: -122.4194 },
    };
    const result = deserializeFirestoreTypes(data);
    expect(result.location).toBeInstanceOf(GeoPoint);
    const gp = result.location as GeoPoint;
    expect(gp.latitude).toBe(37.7749);
    expect(gp.longitude).toBe(-122.4194);
  });

  it('deserializes VectorValue', () => {
    const data = {
      embedding: { [SERIALIZATION_TAG]: 'VectorValue', values: [1.0, 2.0, 3.0] },
    };
    const result = deserializeFirestoreTypes(data);
    // VectorValue is created via FieldValue.vector(); check it reconstructs
    const vec = result.embedding;
    expect(vec).toBeDefined();
    // VectorValue has toArray() method or _values internal
    expect((vec as Record<string, unknown>).constructor?.name).toBe('VectorValue');
  });

  it('leaves DocumentReference tagged when no db provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = {
      ref: { [SERIALIZATION_TAG]: 'DocumentReference', path: 'users/abc123' },
    };
    const result = deserializeFirestoreTypes(data);
    // Should stay as tagged object
    expect((result.ref as Record<string, unknown>)[SERIALIZATION_TAG]).toBe('DocumentReference');
    expect((result.ref as Record<string, unknown>).path).toBe('users/abc123');
    warnSpy.mockRestore();
  });

  it('deserializes nested tagged types', () => {
    const data = {
      meta: {
        timestamps: {
          created: { [SERIALIZATION_TAG]: 'Timestamp', seconds: 1000, nanoseconds: 0 },
        },
      },
    };
    const result = deserializeFirestoreTypes(data);
    const meta = result.meta as Record<string, unknown>;
    const timestamps = meta.timestamps as Record<string, unknown>;
    expect(timestamps.created).toBeInstanceOf(Timestamp);
  });

  it('deserializes tagged types inside arrays', () => {
    const data = {
      points: [
        { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 1, longitude: 2 },
        { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 3, longitude: 4 },
      ],
    };
    const result = deserializeFirestoreTypes(data);
    const points = result.points as GeoPoint[];
    expect(points[0]).toBeInstanceOf(GeoPoint);
    expect(points[1]).toBeInstanceOf(GeoPoint);
    expect(points[0].latitude).toBe(1);
    expect(points[1].latitude).toBe(3);
  });

  it('leaves objects with unknown discriminator as-is', () => {
    const data = {
      custom: { [SERIALIZATION_TAG]: 'UnknownType', value: 42 },
    };
    // Unknown discriminators are not recognized by isTaggedValue, so
    // the object passes through as a plain object (recursed into).
    const result = deserializeFirestoreTypes(data);
    expect((result.custom as Record<string, unknown>)[SERIALIZATION_TAG]).toBe('UnknownType');
  });

  it('handles null and undefined values', () => {
    const data = { a: null, b: undefined, c: 'hello' };
    const result = deserializeFirestoreTypes(data);
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
    expect(result.c).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: serialize → JSON → deserialize
// ---------------------------------------------------------------------------

describe('serialize → JSON.stringify → JSON.parse → deserialize round-trip', () => {
  it('round-trips Timestamp', () => {
    const original = { ts: new Timestamp(1700000000, 123456789) };
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);

    expect(restored.ts).toBeInstanceOf(Timestamp);
    const ts = restored.ts as Timestamp;
    expect(ts.seconds).toBe(1700000000);
    expect(ts.nanoseconds).toBe(123456789);
  });

  it('round-trips GeoPoint', () => {
    const original = { loc: new GeoPoint(37.7749, -122.4194) };
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);

    expect(restored.loc).toBeInstanceOf(GeoPoint);
    const gp = restored.loc as GeoPoint;
    expect(gp.latitude).toBe(37.7749);
    expect(gp.longitude).toBe(-122.4194);
  });

  it('round-trips VectorValue', () => {
    const vector = FieldValue.vector([1.5, 2.5, 3.5]);
    const original = { emb: vector };
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);

    expect((restored.emb as Record<string, unknown>).constructor?.name).toBe('VectorValue');
  });

  it('round-trips complex nested structure', () => {
    const original = {
      name: 'test',
      count: 42,
      createdAt: new Timestamp(1000, 0),
      locations: [new GeoPoint(10, 20), new GeoPoint(30, 40)],
      nested: {
        updatedAt: new Timestamp(2000, 500),
        embedding: FieldValue.vector([0.1, 0.2]),
      },
      tags: ['a', 'b'],
    };

    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);

    // Plain data preserved
    expect(restored.name).toBe('test');
    expect(restored.count).toBe(42);
    expect(restored.tags).toEqual(['a', 'b']);

    // Firestore types reconstructed
    expect(restored.createdAt).toBeInstanceOf(Timestamp);
    expect((restored.createdAt as Timestamp).seconds).toBe(1000);

    const locations = restored.locations as GeoPoint[];
    expect(locations[0]).toBeInstanceOf(GeoPoint);
    expect(locations[0].latitude).toBe(10);
    expect(locations[1]).toBeInstanceOf(GeoPoint);
    expect(locations[1].latitude).toBe(30);

    const nested = restored.nested as Record<string, unknown>;
    expect(nested.updatedAt).toBeInstanceOf(Timestamp);
    expect((nested.updatedAt as Timestamp).nanoseconds).toBe(500);
    expect((nested.embedding as Record<string, unknown>).constructor?.name).toBe('VectorValue');
  });

  it('plain data round-trips as no-op', () => {
    const original = { name: 'test', count: 42, nested: { a: 1 }, arr: [1, 2, 3] };
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);
    expect(restored).toEqual(original);
  });

  it('user data with SERIALIZATION_TAG key but unknown discriminator passes through', () => {
    // A user might coincidentally have the sentinel key in their data
    const original = { [SERIALIZATION_TAG]: 'CustomUserType', value: 42 };
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const restored = deserializeFirestoreTypes(parsed);
    // Unknown discriminator — not recognized as a tagged type, passes through
    expect(restored[SERIALIZATION_TAG]).toBe('CustomUserType');
    expect(restored.value).toBe(42);
  });

  it('tagged object with known type but missing fields passes through unchanged', () => {
    // Protect against user data that coincidentally has the sentinel key
    // and a known type name but lacks the expected fields
    const data = { [SERIALIZATION_TAG]: 'Timestamp', unrelated: 'data' };
    const result = deserializeFirestoreTypes({ field: data });
    const field = result.field as Record<string, unknown>;
    // Should NOT be reconstructed — missing seconds/nanoseconds
    expect(field).not.toBeInstanceOf(Timestamp);
    expect(field[SERIALIZATION_TAG]).toBe('Timestamp');
    expect(field.unrelated).toBe('data');
  });

  it('tagged GeoPoint with wrong field types passes through unchanged', () => {
    const data = { [SERIALIZATION_TAG]: 'GeoPoint', latitude: 'not-a-number', longitude: 0 };
    const result = deserializeFirestoreTypes({ field: data });
    expect(result.field).not.toBeInstanceOf(GeoPoint);
    expect((result.field as Record<string, unknown>)[SERIALIZATION_TAG]).toBe('GeoPoint');
  });

  it('tagged VectorValue with non-array values passes through unchanged', () => {
    const data = { [SERIALIZATION_TAG]: 'VectorValue', values: 'not-an-array' };
    const result = deserializeFirestoreTypes({ field: data });
    expect((result.field as Record<string, unknown>)[SERIALIZATION_TAG]).toBe('VectorValue');
  });
});

// ---------------------------------------------------------------------------
// Idempotency: deserialize already-deserialized data
// ---------------------------------------------------------------------------

describe('deserializeFirestoreTypes — idempotency', () => {
  it('passes through real Timestamp instances unchanged', () => {
    const ts = new Timestamp(1000, 500);
    const data = { createdAt: ts, name: 'test' };
    const result = deserializeFirestoreTypes(data);
    // Should be the exact same Timestamp instance, not destructured
    expect(result.createdAt).toBe(ts);
    expect(result.createdAt).toBeInstanceOf(Timestamp);
  });

  it('passes through real GeoPoint instances unchanged', () => {
    const gp = new GeoPoint(37.7, -122.4);
    const data = { location: gp };
    const result = deserializeFirestoreTypes(data);
    expect(result.location).toBe(gp);
    expect(result.location).toBeInstanceOf(GeoPoint);
  });

  it('passes through real VectorValue instances unchanged', () => {
    const vec = FieldValue.vector([1, 2, 3]);
    const data = { embedding: vec };
    const result = deserializeFirestoreTypes(data);
    expect(result.embedding).toBe(vec);
  });

  it('double-deserialize after full round-trip preserves types', () => {
    const original = {
      ts: new Timestamp(1000, 0),
      loc: new GeoPoint(10, 20),
    };
    // First round-trip: serialize → JSON → parse → deserialize
    const serialized = serializeFirestoreTypes(original);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const first = deserializeFirestoreTypes(parsed);

    // Second deserialize (simulating write-back calling deserialize again)
    const second = deserializeFirestoreTypes(first);
    expect(second.ts).toBeInstanceOf(Timestamp);
    expect((second.ts as Timestamp).seconds).toBe(1000);
    expect(second.loc).toBeInstanceOf(GeoPoint);
    expect((second.loc as GeoPoint).latitude).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// DocumentReference with mock db
// ---------------------------------------------------------------------------

describe('deserializeFirestoreTypes — DocumentReference with db', () => {
  it('reconstructs DocumentReference when db is provided', () => {
    const mockDocRef = { id: 'abc123', path: 'users/abc123' };
    const mockDb = {
      doc: vi.fn().mockReturnValue(mockDocRef),
    } as unknown as Firestore;

    const data = {
      ref: { [SERIALIZATION_TAG]: 'DocumentReference', path: 'users/abc123' },
    };
    const result = deserializeFirestoreTypes(data, mockDb);
    expect(mockDb.doc).toHaveBeenCalledWith('users/abc123');
    expect(result.ref).toBe(mockDocRef);
  });

  it('tagged DocumentReference without path field passes through', () => {
    const data = {
      ref: { [SERIALIZATION_TAG]: 'DocumentReference', notPath: 'wrong' },
    };
    const result = deserializeFirestoreTypes(data);
    expect((result.ref as Record<string, unknown>)[SERIALIZATION_TAG]).toBe('DocumentReference');
  });
});
