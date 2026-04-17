/**
 * Unit tests for the storage-scope path helpers.
 *
 * These operate on the materialized-path `storageScope` string that the
 * SQLite backend produces from chained `subgraph()` calls — interleaved
 * `<uid>/<name>` pairs with no leading collection segment. A custom
 * router (e.g. one that uses `storageScope` as a Durable Object name)
 * reuses these helpers to decode that string without re-deriving the
 * parsing rules.
 */

import { describe, expect, it } from 'vitest';

import {
  appendStorageScope,
  isAncestorScopeUid,
  parseStorageScope,
  resolveAncestorScope,
} from '../../src/scope-path.js';

describe('parseStorageScope', () => {
  it('returns an empty array for the root scope', () => {
    expect(parseStorageScope('')).toEqual([]);
  });

  it('parses a single-level scope', () => {
    expect(parseStorageScope('A/memories')).toEqual([{ uid: 'A', name: 'memories' }]);
  });

  it('parses a multi-level scope', () => {
    expect(parseStorageScope('A/memories/B/context')).toEqual([
      { uid: 'A', name: 'memories' },
      { uid: 'B', name: 'context' },
    ]);
  });

  it('throws on an odd-segment-count scope', () => {
    expect(() => parseStorageScope('A/memories/B')).toThrow(/INVALID_SCOPE_PATH/);
  });

  it('throws when any segment is empty (trailing slash)', () => {
    expect(() => parseStorageScope('A/')).toThrow(/INVALID_SCOPE_PATH/);
  });

  it('throws when the first segment is empty (leading slash)', () => {
    expect(() => parseStorageScope('/memories')).toThrow(/INVALID_SCOPE_PATH/);
  });
});

describe('resolveAncestorScope', () => {
  it('returns null for the root scope', () => {
    expect(resolveAncestorScope('', 'A')).toBeNull();
  });

  it('returns empty string when the UID was added at root', () => {
    // `g.subgraph(A, 'memories')` was the call that produced this scope,
    // so `A` lives at the root — ancestor scope is `''`.
    expect(resolveAncestorScope('A/memories', 'A')).toBe('');
  });

  it('returns the enclosing scope for a UID added one level down', () => {
    // `.subgraph(B, 'context')` on the memories subgraph means B lives
    // inside `A/memories`.
    expect(resolveAncestorScope('A/memories/B/context', 'B')).toBe('A/memories');
  });

  it('returns the enclosing scope for a UID deep in the chain', () => {
    const scope = 'A/l1/B/l2/C/l3/D/l4';
    expect(resolveAncestorScope(scope, 'A')).toBe('');
    expect(resolveAncestorScope(scope, 'B')).toBe('A/l1');
    expect(resolveAncestorScope(scope, 'C')).toBe('A/l1/B/l2');
    expect(resolveAncestorScope(scope, 'D')).toBe('A/l1/B/l2/C/l3');
  });

  it('returns null for a UID not in the scope', () => {
    expect(resolveAncestorScope('A/memories/B/context', 'X')).toBeNull();
  });

  it('does not match subgraph-name segments', () => {
    // `memories` and `context` are at odd indices (names, not UIDs) and
    // must not match a UID lookup.
    expect(resolveAncestorScope('A/memories/B/context', 'memories')).toBeNull();
    expect(resolveAncestorScope('A/memories/B/context', 'context')).toBeNull();
  });

  it('matches the first occurrence when a UID appears multiple times', () => {
    expect(resolveAncestorScope('X/first/X/second', 'X')).toBe('');
  });

  it('returns null for an empty UID lookup', () => {
    expect(resolveAncestorScope('A/memories', '')).toBeNull();
  });
});

describe('isAncestorScopeUid', () => {
  it('returns true when the UID is present at a UID position', () => {
    expect(isAncestorScopeUid('A/memories/B/context', 'A')).toBe(true);
    expect(isAncestorScopeUid('A/memories/B/context', 'B')).toBe(true);
  });

  it('returns false when the UID is not present', () => {
    expect(isAncestorScopeUid('A/memories/B/context', 'X')).toBe(false);
  });

  it('returns false for subgraph-name segments', () => {
    expect(isAncestorScopeUid('A/memories', 'memories')).toBe(false);
  });

  it('returns false for the root scope', () => {
    expect(isAncestorScopeUid('', 'A')).toBe(false);
  });
});

describe('appendStorageScope', () => {
  it('produces a one-level scope from root', () => {
    expect(appendStorageScope('', 'A', 'memories')).toBe('A/memories');
  });

  it('appends to an existing scope', () => {
    expect(appendStorageScope('A/memories', 'B', 'context')).toBe('A/memories/B/context');
  });

  it('round-trips with parseStorageScope', () => {
    let scope = '';
    scope = appendStorageScope(scope, 'A', 'memories');
    scope = appendStorageScope(scope, 'B', 'context');
    scope = appendStorageScope(scope, 'C', 'inner');
    expect(parseStorageScope(scope)).toEqual([
      { uid: 'A', name: 'memories' },
      { uid: 'B', name: 'context' },
      { uid: 'C', name: 'inner' },
    ]);
  });

  it('rejects a uid containing "/"', () => {
    expect(() => appendStorageScope('', 'A/B', 'memories')).toThrow(/INVALID_SCOPE_PATH/);
  });

  it('rejects an empty uid', () => {
    expect(() => appendStorageScope('', '', 'memories')).toThrow(/INVALID_SCOPE_PATH/);
  });

  it('rejects a name containing "/"', () => {
    expect(() => appendStorageScope('', 'A', 'mem/ories')).toThrow(/INVALID_SCOPE_PATH/);
  });

  it('rejects an empty name', () => {
    expect(() => appendStorageScope('', 'A', '')).toThrow(/INVALID_SCOPE_PATH/);
  });
});
