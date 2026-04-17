import { describe, expect, it } from 'vitest';

import { matchScope, matchScopeAny } from '../../src/scope.js';

describe('matchScope', () => {
  describe('root pattern', () => {
    it('matches empty scope path (root graph)', () => {
      expect(matchScope('', 'root')).toBe(true);
    });

    it('does not match non-empty scope path', () => {
      expect(matchScope('agents', 'root')).toBe(false);
      expect(matchScope('agents/memories', 'root')).toBe(false);
    });
  });

  describe('literal patterns', () => {
    it('matches exact single-segment path', () => {
      expect(matchScope('agents', 'agents')).toBe(true);
    });

    it('does not match different single-segment path', () => {
      expect(matchScope('tasks', 'agents')).toBe(false);
    });

    it('matches exact multi-segment path', () => {
      expect(matchScope('agents/memories', 'agents/memories')).toBe(true);
    });

    it('does not match partial path', () => {
      expect(matchScope('agents', 'agents/memories')).toBe(false);
      expect(matchScope('agents/memories', 'agents')).toBe(false);
    });

    it('does not match root against a literal pattern', () => {
      expect(matchScope('', 'agents')).toBe(false);
    });
  });

  describe('single wildcard (*)', () => {
    it('matches one segment', () => {
      expect(matchScope('foo/agents', '*/agents')).toBe(true);
      expect(matchScope('bar/agents', '*/agents')).toBe(true);
    });

    it('does not match zero segments', () => {
      expect(matchScope('agents', '*/agents')).toBe(false);
    });

    it('does not match multiple segments', () => {
      expect(matchScope('a/b/agents', '*/agents')).toBe(false);
    });

    it('works in multiple positions', () => {
      expect(matchScope('a/b/c', '*/*/**')).toBe(true);
      expect(matchScope('x/y', '*/*')).toBe(true);
    });

    it('works as the only segment', () => {
      expect(matchScope('anything', '*')).toBe(true);
      expect(matchScope('a/b', '*')).toBe(false);
    });
  });

  describe('double wildcard (**)', () => {
    it('matches everything when used alone', () => {
      expect(matchScope('', '**')).toBe(true);
      expect(matchScope('agents', '**')).toBe(true);
      expect(matchScope('agents/memories', '**')).toBe(true);
      expect(matchScope('a/b/c/d', '**')).toBe(true);
    });

    it('matches zero or more segments as prefix', () => {
      expect(matchScope('memories', '**/memories')).toBe(true);
      expect(matchScope('agents/memories', '**/memories')).toBe(true);
      expect(matchScope('a/b/c/memories', '**/memories')).toBe(true);
    });

    it('does not match when trailing segment differs', () => {
      expect(matchScope('agents/tasks', '**/memories')).toBe(false);
    });

    it('works as prefix', () => {
      expect(matchScope('agents/foo/bar', 'agents/**')).toBe(true);
      expect(matchScope('agents', 'agents/**')).toBe(true);
    });

    it('works in the middle', () => {
      expect(matchScope('agents/x/y/memories', 'agents/**/memories')).toBe(true);
      expect(matchScope('agents/memories', 'agents/**/memories')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('empty pattern does not match root (use "root" for that)', () => {
      // Empty string pattern splits into [''], which doesn't match empty path []
      expect(matchScope('', '')).toBe(false);
    });

    it('deeply nested path matches deeply nested pattern', () => {
      expect(matchScope('a/b/c/d/e', 'a/b/c/d/e')).toBe(true);
    });

    it('mixed wildcards', () => {
      expect(matchScope('a/b/c/d', '*/**/d')).toBe(true);
      expect(matchScope('a/d', '*/**/d')).toBe(true);
    });

    it('consecutive ** wildcards', () => {
      expect(matchScope('a/b/c', '**/**')).toBe(true);
      expect(matchScope('a', '**/**')).toBe(true);
      expect(matchScope('', '**/**')).toBe(true);
    });

    it('** then * then literal', () => {
      expect(matchScope('a/b/c', '**/**/c')).toBe(true);
      expect(matchScope('c', '**/**/c')).toBe(true);
      expect(matchScope('a/b/d', '**/**/c')).toBe(false);
    });

    it('prefix/** does not match root', () => {
      expect(matchScope('', 'agents/**')).toBe(false);
    });

    it('prefix/** matches the prefix itself', () => {
      expect(matchScope('agents', 'agents/**')).toBe(true);
    });

    it('prefix/** matches deeper paths', () => {
      expect(matchScope('agents/memories', 'agents/**')).toBe(true);
      expect(matchScope('agents/a/b/c', 'agents/**')).toBe(true);
    });
  });
});

describe('matchScopeAny', () => {
  it('returns true for empty patterns array (allowed everywhere)', () => {
    expect(matchScopeAny('anything', [])).toBe(true);
    expect(matchScopeAny('', [])).toBe(true);
  });

  it('returns true for undefined-like patterns', () => {
    expect(matchScopeAny('anything', undefined as unknown as string[])).toBe(true);
  });

  it('returns true if any pattern matches', () => {
    expect(matchScopeAny('agents', ['root', 'agents'])).toBe(true);
  });

  it('returns false if no pattern matches', () => {
    expect(matchScopeAny('tasks', ['root', 'agents'])).toBe(false);
  });

  it('works with wildcard patterns', () => {
    expect(matchScopeAny('foo/memories', ['root', '**/memories'])).toBe(true);
    expect(matchScopeAny('foo/tasks', ['root', '**/memories'])).toBe(false);
  });
});
