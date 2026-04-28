/**
 * Unit tests for the write-plan helpers — `flattenPatch`, `DELETE_FIELD`,
 * `assertNoDeleteSentinels`, `assertSafePath`, `assertUpdatePayloadExclusive`.
 *
 * The integration suite in `tests/integration/write-semantics.test.ts`
 * covers cross-backend behaviour. This file pins down the lower-level
 * payload-flattening contract that every backend depends on.
 */

import { describe, expect, it } from 'vitest';

import { SERIALIZATION_TAG } from '../../src/internal/serialization-tag.js';
import {
  assertNoDeleteSentinels,
  assertSafePath,
  assertUpdatePayloadExclusive,
  DELETE_FIELD,
  deleteField,
  flattenPatch,
  isDeleteSentinel,
} from '../../src/internal/write-plan.js';

describe('deleteField sentinel', () => {
  it('returns the same Symbol every call', () => {
    expect(deleteField()).toBe(DELETE_FIELD);
    expect(deleteField()).toBe(deleteField());
  });

  it('isDeleteSentinel recognises only the sentinel', () => {
    expect(isDeleteSentinel(DELETE_FIELD)).toBe(true);
    expect(isDeleteSentinel(deleteField())).toBe(true);
    expect(isDeleteSentinel(undefined)).toBe(false);
    expect(isDeleteSentinel(null)).toBe(false);
    expect(isDeleteSentinel({})).toBe(false);
    expect(isDeleteSentinel(Symbol('other'))).toBe(false);
  });
});

describe('flattenPatch — primitives & objects', () => {
  it('flattens shallow primitives', () => {
    const ops = flattenPatch({ a: 1, b: 'two', c: true, d: null });
    expect(ops).toEqual([
      { path: ['a'], value: 1, delete: false },
      { path: ['b'], value: 'two', delete: false },
      { path: ['c'], value: true, delete: false },
      { path: ['d'], value: null, delete: false },
    ]);
  });

  it('recurses into nested plain objects', () => {
    const ops = flattenPatch({ a: { b: { c: 1, d: 2 } } });
    expect(ops).toEqual([
      { path: ['a', 'b', 'c'], value: 1, delete: false },
      { path: ['a', 'b', 'd'], value: 2, delete: false },
    ]);
  });

  it('skips undefined keys entirely (no op generated)', () => {
    const ops = flattenPatch({ a: 1, b: undefined, c: 3 });
    expect(ops).toEqual([
      { path: ['a'], value: 1, delete: false },
      { path: ['c'], value: 3, delete: false },
    ]);
  });

  it('preserves null as a real terminal write', () => {
    const ops = flattenPatch({ a: null });
    expect(ops).toEqual([{ path: ['a'], value: null, delete: false }]);
  });

  it('arrays are terminal — never recursed into', () => {
    const ops = flattenPatch({ tags: ['a', 'b'], scores: [1, 2] });
    expect(ops).toEqual([
      { path: ['tags'], value: ['a', 'b'], delete: false },
      { path: ['scores'], value: [1, 2], delete: false },
    ]);
  });

  it('empty objects at the root produce no ops', () => {
    expect(flattenPatch({})).toEqual([]);
  });

  it('empty objects at a non-root key produce a terminal empty-object op', () => {
    const ops = flattenPatch({ meta: {} });
    expect(ops).toEqual([{ path: ['meta'], value: {}, delete: false }]);
  });
});

describe('flattenPatch — DELETE_FIELD sentinel', () => {
  it('emits a delete op at the right path', () => {
    const ops = flattenPatch({ a: deleteField() });
    expect(ops).toEqual([{ path: ['a'], value: undefined, delete: true }]);
  });

  it('emits a delete op deep in the tree', () => {
    const ops = flattenPatch({ profile: { settings: { theme: deleteField() } } });
    expect(ops).toEqual([
      { path: ['profile', 'settings', 'theme'], value: undefined, delete: true },
    ]);
  });

  it('throws when the entire payload is the sentinel', () => {
    expect(() => flattenPatch(deleteField() as unknown as Record<string, unknown>)).toThrow(
      /cannot be the entire update payload/,
    );
  });

  it('rejects a sentinel embedded as an array element', () => {
    expect(() => flattenPatch({ tags: [deleteField()] })).toThrow(
      /sentinel at index 0 inside an array/,
    );
  });

  it('rejects a sentinel inside a nested array', () => {
    expect(() => flattenPatch({ matrix: [[1, deleteField(), 3]] })).toThrow(/sentinel at index 1/);
  });

  it('rejects a sentinel inside an object inside an array', () => {
    expect(() => flattenPatch({ list: [{ a: deleteField() }] })).toThrow(
      /sentinel inside an array element/,
    );
  });

  it('rejects a sentinel deep inside an object inside an array', () => {
    expect(() => flattenPatch({ tags: [{ deep: { drop: deleteField() } }] })).toThrow(
      /sentinel inside an array element/,
    );
  });

  it('rejects a sentinel inside a nested array inside an object inside an array', () => {
    expect(() => flattenPatch({ list: [{ inner: [deleteField()] }] })).toThrow(
      /sentinel at index 0 inside an array/,
    );
  });
});

describe('flattenPatch — terminal special types', () => {
  it('treats tagged Firestore-type payloads as terminal (no recursion)', () => {
    const tagged = {
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 1700000000,
      nanoseconds: 0,
    };
    const ops = flattenPatch({ ts: tagged });
    expect(ops).toEqual([{ path: ['ts'], value: tagged, delete: false }]);
  });

  it('class instances are terminal (Date)', () => {
    const d = new Date('2025-01-01T00:00:00Z');
    const ops = flattenPatch({ when: d });
    expect(ops).toEqual([{ path: ['when'], value: d, delete: false }]);
  });

  it('throws on non-plain root', () => {
    expect(() => flattenPatch(null as unknown as Record<string, unknown>)).toThrow(
      /must be a plain object/,
    );
    expect(() => flattenPatch([] as unknown as Record<string, unknown>)).toThrow(
      /must be a plain object/,
    );
    expect(() => flattenPatch(42 as unknown as Record<string, unknown>)).toThrow(
      /must be a plain object/,
    );
  });
});

describe('flattenPatch — unsafe key rejection', () => {
  it('rejects keys with dots', () => {
    expect(() => flattenPatch({ 'a.b': 1 })).toThrow(/unsafe object key "a\.b"/);
  });

  it('rejects keys with brackets', () => {
    expect(() => flattenPatch({ 'a[0]': 1 })).toThrow(/unsafe object key "a\[0\]"/);
  });

  it('rejects keys with whitespace', () => {
    expect(() => flattenPatch({ 'first name': 1 })).toThrow(/unsafe object key "first name"/);
  });

  it('rejects empty key', () => {
    expect(() => flattenPatch({ '': 1 })).toThrow(/unsafe object key/);
  });

  it('rejects keys starting with a digit', () => {
    expect(() => flattenPatch({ '1abc': 1 })).toThrow(/unsafe object key/);
  });

  it('accepts kebab/snake/camel identifiers', () => {
    expect(() =>
      flattenPatch({ camelCase: 1, snake_case: 2, 'kebab-case': 3, _under: 4 }),
    ).not.toThrow();
  });

  it('rejects unsafe keys deep in the tree', () => {
    expect(() => flattenPatch({ a: { 'b.c': 1 } })).toThrow(/unsafe object key "b\.c"/);
  });

  it('rejects a literal SERIALIZATION_TAG key on a plain object', () => {
    expect(() =>
      flattenPatch({ [SERIALIZATION_TAG]: 'not-a-known-type', other: 1 } as Record<
        string,
        unknown
      >),
    ).toThrow(/literal `__firegraph_ser__` key/);
  });

  it('rejects a literal SERIALIZATION_TAG key nested inside a plain object', () => {
    expect(() =>
      flattenPatch({ wrapper: { [SERIALIZATION_TAG]: 42 } } as Record<string, unknown>),
    ).toThrow(/literal `__firegraph_ser__` key/);
  });
});

describe('assertSafePath', () => {
  it('accepts safe paths', () => {
    expect(() => assertSafePath(['a', 'b_c', 'd-e', '_f'])).not.toThrow();
  });

  it('rejects unsafe paths', () => {
    expect(() => assertSafePath(['a', 'b.c'])).toThrow(/unsafe object key/);
    expect(() => assertSafePath(['1abc'])).toThrow(/unsafe object key/);
  });
});

describe('assertUpdatePayloadExclusive', () => {
  it('accepts replaceData alone', () => {
    expect(() => assertUpdatePayloadExclusive({ replaceData: { a: 1 } })).not.toThrow();
  });

  it('accepts dataOps alone', () => {
    expect(() => assertUpdatePayloadExclusive({ dataOps: [] })).not.toThrow();
  });

  it('accepts an empty payload', () => {
    expect(() => assertUpdatePayloadExclusive({})).not.toThrow();
  });

  it('throws when both are present', () => {
    expect(() => assertUpdatePayloadExclusive({ replaceData: {}, dataOps: [] })).toThrow(
      /cannot specify both/,
    );
  });
});

describe('assertNoDeleteSentinels', () => {
  it('accepts plain payloads', () => {
    expect(() =>
      assertNoDeleteSentinels({ a: 1, b: { c: 'x', d: [1, 2] } }, 'replaceNode'),
    ).not.toThrow();
  });

  it('accepts null / undefined values', () => {
    expect(() => assertNoDeleteSentinels({ a: null, b: undefined }, 'replaceNode')).not.toThrow();
  });

  it('rejects sentinel at root level', () => {
    expect(() => assertNoDeleteSentinels({ a: deleteField() }, 'replaceNode')).toThrow(
      /replaceNode payload contains a deleteField\(\) sentinel/,
    );
  });

  it('rejects sentinel deep in the tree', () => {
    expect(() => assertNoDeleteSentinels({ a: { b: { c: deleteField() } } }, 'putNode')).toThrow(
      /putNode payload contains a deleteField\(\) sentinel/,
    );
  });

  it('rejects sentinel inside an array', () => {
    expect(() => assertNoDeleteSentinels({ list: [1, deleteField(), 3] }, 'replaceEdge')).toThrow(
      /replaceEdge payload contains a deleteField\(\) sentinel/,
    );
  });

  it('does not recurse into tagged Firestore-type payloads', () => {
    const tagged = {
      [SERIALIZATION_TAG]: 'Timestamp',
      seconds: 1700000000,
      nanoseconds: 0,
    };
    expect(() => assertNoDeleteSentinels({ ts: tagged }, 'replaceNode')).not.toThrow();
  });

  it('does not recurse into class instances (Date)', () => {
    expect(() => assertNoDeleteSentinels({ when: new Date() }, 'replaceNode')).not.toThrow();
  });
});

