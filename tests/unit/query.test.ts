import { describe, it, expect } from 'vitest';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from '../../src/query.js';
import { InvalidQueryError } from '../../src/errors.js';
import { NODE_RELATION, DEFAULT_QUERY_LIMIT } from '../../src/internal/constants.js';

describe('buildEdgeQueryPlan', () => {
  it('returns strategy "get" when all three params provided', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1', axbType: 'hasDep', bUid: 'b2' });
    expect(plan.strategy).toBe('get');
    if (plan.strategy === 'get') {
      expect(plan.docId).toContain('a1');
      expect(plan.docId).toContain('hasDep');
      expect(plan.docId).toContain('b2');
    }
  });

  it('returns strategy "query" for forward lookup (aUid + axbType)', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1', axbType: 'hasDep' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(2);
      expect(plan.filters).toContainEqual({ field: 'aUid', op: '==', value: 'a1' });
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: 'hasDep' });
    }
  });

  it('returns strategy "query" for reverse lookup (axbType + bUid)', () => {
    const plan = buildEdgeQueryPlan({ axbType: 'bookedFor', bUid: 'dep1' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(2);
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: 'bookedFor' });
      expect(plan.filters).toContainEqual({ field: 'bUid', op: '==', value: 'dep1' });
    }
  });

  it('returns strategy "query" for single param (aUid only)', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(1);
      expect(plan.filters[0]).toEqual({ field: 'aUid', op: '==', value: 'a1' });
    }
  });

  it('returns strategy "query" for type-scoped forward (aType + axbType)', () => {
    const plan = buildEdgeQueryPlan({ aType: 'tour', axbType: 'hasDep' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(2);
      expect(plan.filters).toContainEqual({ field: 'aType', op: '==', value: 'tour' });
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: 'hasDep' });
    }
  });

  it('returns strategy "query" for type-scoped reverse (axbType + bType)', () => {
    const plan = buildEdgeQueryPlan({ axbType: 'bookedFor', bType: 'rider' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(2);
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: 'bookedFor' });
      expect(plan.filters).toContainEqual({ field: 'bType', op: '==', value: 'rider' });
    }
  });

  it('includes all provided filters', () => {
    const plan = buildEdgeQueryPlan({ aType: 'tour', aUid: 'a1', axbType: 'hasDep' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(3);
      expect(plan.filters).toContainEqual({ field: 'aType', op: '==', value: 'tour' });
      expect(plan.filters).toContainEqual({ field: 'aUid', op: '==', value: 'a1' });
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: 'hasDep' });
    }
  });

  it('throws InvalidQueryError when no params provided', () => {
    expect(() => buildEdgeQueryPlan({})).toThrow(InvalidQueryError);
  });

  it('applies DEFAULT_QUERY_LIMIT when no explicit limit is set', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1', axbType: 'hasDep' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBe(DEFAULT_QUERY_LIMIT);
    }
  });

  it('uses explicit limit over default', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1', axbType: 'hasDep', limit: 10 });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBe(10);
    }
  });

  it('limit: 0 bypasses default limit (unlimited)', () => {
    const plan = buildEdgeQueryPlan({ aUid: 'a1', axbType: 'hasDep', limit: 0 });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBeUndefined();
    }
  });

  it('passes through orderBy in options', () => {
    const plan = buildEdgeQueryPlan({
      aUid: 'a1',
      axbType: 'hasDep',
      orderBy: { field: 'data.date', direction: 'desc' },
    });
    if (plan.strategy === 'query') {
      expect(plan.options?.orderBy).toEqual({ field: 'data.date', direction: 'desc' });
    }
  });

  it('prefixes non-builtin where clause fields with data.', () => {
    const plan = buildEdgeQueryPlan({
      aUid: 'a1',
      axbType: 'hasDep',
      where: [{ field: 'status', op: '==', value: 'active' }],
    });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toContainEqual({ field: 'data.status', op: '==', value: 'active' });
    }
  });

  it('does not prefix already-prefixed data. fields', () => {
    const plan = buildEdgeQueryPlan({
      aUid: 'a1',
      axbType: 'hasDep',
      where: [{ field: 'data.name', op: '==', value: 'test' }],
    });
    if (plan.strategy === 'query') {
      expect(plan.filters).toContainEqual({ field: 'data.name', op: '==', value: 'test' });
    }
  });
});

describe('buildNodeQueryPlan', () => {
  it('returns strategy "query" with aType and axbType filters', () => {
    const plan = buildNodeQueryPlan({ aType: 'tour' });
    expect(plan.strategy).toBe('query');
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(2);
      expect(plan.filters).toContainEqual({ field: 'aType', op: '==', value: 'tour' });
      expect(plan.filters).toContainEqual({ field: 'axbType', op: '==', value: NODE_RELATION });
    }
  });

  it('applies DEFAULT_QUERY_LIMIT when no explicit limit is set', () => {
    const plan = buildNodeQueryPlan({ aType: 'tour' });
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBe(DEFAULT_QUERY_LIMIT);
    }
  });

  it('uses explicit limit over default', () => {
    const plan = buildNodeQueryPlan({ aType: 'tour', limit: 25 });
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBe(25);
    }
  });

  it('limit: 0 bypasses default limit (unlimited)', () => {
    const plan = buildNodeQueryPlan({ aType: 'tour', limit: 0 });
    if (plan.strategy === 'query') {
      expect(plan.options?.limit).toBeUndefined();
    }
  });

  it('supports orderBy', () => {
    const plan = buildNodeQueryPlan({
      aType: 'tour',
      orderBy: { field: 'data.name', direction: 'asc' },
    });
    if (plan.strategy === 'query') {
      expect(plan.options?.orderBy).toEqual({ field: 'data.name', direction: 'asc' });
    }
  });

  it('supports where clauses with data. prefix', () => {
    const plan = buildNodeQueryPlan({
      aType: 'tour',
      where: [{ field: 'status', op: '==', value: 'active' }],
    });
    if (plan.strategy === 'query') {
      expect(plan.filters).toHaveLength(3);
      expect(plan.filters).toContainEqual({ field: 'data.status', op: '==', value: 'active' });
    }
  });

  it('passes through builtin field where clauses', () => {
    const plan = buildNodeQueryPlan({
      aType: 'tour',
      where: [{ field: 'createdAt', op: '>', value: '2024-01-01' }],
    });
    if (plan.strategy === 'query') {
      expect(plan.filters).toContainEqual({ field: 'createdAt', op: '>', value: '2024-01-01' });
    }
  });
});
