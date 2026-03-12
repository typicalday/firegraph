import { describe, it, expect } from 'vitest';
import { resolveAncestorCollection, isAncestorUid } from '../../src/cross-graph.js';

describe('resolveAncestorCollection', () => {
  it('returns collection path for a UID at the first doc segment', () => {
    expect(resolveAncestorCollection('graph/A/workspace', 'A')).toBe('graph');
  });

  it('returns collection path for a UID deeper in the path', () => {
    expect(resolveAncestorCollection('graph/A/workspace/B/context', 'B'))
      .toBe('graph/A/workspace');
  });

  it('returns first-level collection for UID at position 1', () => {
    expect(resolveAncestorCollection('graph/A/workspace/B/context', 'A'))
      .toBe('graph');
  });

  it('returns null when UID is not in the path', () => {
    expect(resolveAncestorCollection('graph/A/workspace', 'X')).toBeNull();
  });

  it('does not match collection segments (even indices)', () => {
    // 'graph' is at index 0 (collection), not a doc ID
    expect(resolveAncestorCollection('graph/A/workspace', 'graph')).toBeNull();
    // 'workspace' is at index 2 (collection)
    expect(resolveAncestorCollection('graph/A/workspace', 'workspace')).toBeNull();
  });

  it('handles simple root collection path', () => {
    // No doc segments in a single-segment path
    expect(resolveAncestorCollection('graph', 'graph')).toBeNull();
  });

  it('handles deeply nested paths', () => {
    const path = 'root/A/l1/B/l2/C/l3/D/l4';
    expect(resolveAncestorCollection(path, 'A')).toBe('root');
    expect(resolveAncestorCollection(path, 'B')).toBe('root/A/l1');
    expect(resolveAncestorCollection(path, 'C')).toBe('root/A/l1/B/l2');
    expect(resolveAncestorCollection(path, 'D')).toBe('root/A/l1/B/l2/C/l3');
  });

  it('handles test-style paths with nested collection segments', () => {
    // The test setup uses paths like test/{uuid}/graph
    const path = 'test/abc123/graph/X/memories';
    expect(resolveAncestorCollection(path, 'abc123')).toBe('test');
    expect(resolveAncestorCollection(path, 'X')).toBe('test/abc123/graph');
  });

  it('returns null for empty string UID', () => {
    expect(resolveAncestorCollection('graph/A/workspace', '')).toBeNull();
  });

  it('matches the first occurrence when UID appears multiple times in the path', () => {
    // UID 'X' appears at index 1 and index 3
    const path = 'root/X/sub/X/deep';
    // Should match the first occurrence (index 1)
    expect(resolveAncestorCollection(path, 'X')).toBe('root');
  });

  it('handles two-segment path (collection/doc)', () => {
    expect(resolveAncestorCollection('graph/A', 'A')).toBe('graph');
  });
});

describe('isAncestorUid', () => {
  it('returns true when UID is in the path', () => {
    expect(isAncestorUid('graph/A/workspace', 'A')).toBe(true);
  });

  it('returns false when UID is not in the path', () => {
    expect(isAncestorUid('graph/A/workspace', 'X')).toBe(false);
  });

  it('returns false for collection segment matches', () => {
    expect(isAncestorUid('graph/A/workspace', 'workspace')).toBe(false);
  });
});
