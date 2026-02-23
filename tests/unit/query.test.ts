import { describe, it, expect } from 'vitest';
import { buildEdgeQueryPlan, buildNodeQueryPlan } from '../../src/query.js';
import { InvalidQueryError } from '../../src/errors.js';
import { NODE_RELATION } from '../../src/internal/constants.js';

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
});
