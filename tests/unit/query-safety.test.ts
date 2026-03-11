import { describe, it, expect } from 'vitest';
import { analyzeQuerySafety } from '../../src/query-safety.js';
import type { QueryFilter } from '../../src/types.js';

describe('analyzeQuerySafety', () => {
  // ---------------------------------------------------------------------------
  // Safe patterns
  // ---------------------------------------------------------------------------

  it('marks (aUid + axbType) as safe', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
      { field: 'axbType', op: '==', value: 'hasDep' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  it('marks (axbType + bUid) as safe', () => {
    const filters: QueryFilter[] = [
      { field: 'axbType', op: '==', value: 'hasDep' },
      { field: 'bUid', op: '==', value: 'xyz' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  it('marks (aType + axbType) as safe', () => {
    const filters: QueryFilter[] = [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'is' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  it('marks (axbType + bType) as safe', () => {
    const filters: QueryFilter[] = [
      { field: 'axbType', op: '==', value: 'hasDep' },
      { field: 'bType', op: '==', value: 'departure' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  it('marks superset of safe pattern as safe (aUid + axbType + bType)', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
      { field: 'axbType', op: '==', value: 'hasDep' },
      { field: 'bType', op: '==', value: 'departure' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  it('marks safe pattern with data.* filter as safe', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
      { field: 'axbType', op: '==', value: 'hasDep' },
      { field: 'data.status', op: '==', value: 'active' },
    ];
    expect(analyzeQuerySafety(filters)).toEqual({ safe: true });
  });

  // ---------------------------------------------------------------------------
  // Unsafe patterns
  // ---------------------------------------------------------------------------

  it('marks lone aUid as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain('aUid');
  });

  it('marks lone bUid as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'bUid', op: '==', value: 'xyz' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
  });

  it('marks lone axbType as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'axbType', op: '==', value: 'hasDep' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
  });

  it('marks lone aType as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'aType', op: '==', value: 'tour' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
  });

  it('marks data-only filters as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'data.status', op: '==', value: 'active' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('data.*');
  });

  it('marks (aUid + bUid) without axbType as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
      { field: 'bUid', op: '==', value: 'xyz' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
  });

  it('marks (aType + bType) without axbType as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'bType', op: '==', value: 'departure' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
  });

  it('marks unindexed builtin + data filter as unsafe', () => {
    const filters: QueryFilter[] = [
      { field: 'aUid', op: '==', value: 'abc' },
      { field: 'data.name', op: '==', value: 'test' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('data.*');
  });

  it('marks empty filter array as unsafe', () => {
    const result = analyzeQuerySafety([]);
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('includes safe patterns in the reason message', () => {
    const filters: QueryFilter[] = [
      { field: 'aType', op: '==', value: 'tour' },
    ];
    const result = analyzeQuerySafety(filters);
    expect(result.reason).toContain('aUid + axbType');
    expect(result.reason).toContain('allowCollectionScan');
  });
});
