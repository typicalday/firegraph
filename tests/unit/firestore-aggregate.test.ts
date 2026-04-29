/**
 * Unit tests for `runFirestoreAggregate` — the shared classic-API aggregate
 * helper used by both Firestore Standard and Enterprise backends.
 *
 * These tests use a hand-rolled mock `Query` with `where()` and `aggregate()`
 * methods so we can validate the translation layer without touching a real
 * Firestore. The translation surface is small (count/sum/avg) plus an
 * edition-aware error path for min/max.
 */

import { AggregateField } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  applyFiltersToQuery,
  runFirestoreAggregate,
} from '../../src/internal/firestore-aggregate.js';

/**
 * Build a chainable mock Query that records every `where()` call and lets the
 * caller stub the `aggregate(...).get()` result. The mock returns itself from
 * `where()` so the filter loop can chain freely.
 */
function makeMockQuery(snapData: Record<string, number | null>) {
  const whereCalls: Array<{ field: string; op: string; value: unknown }> = [];
  let aggregationsPassed: Record<string, unknown> | null = null;

  const query: any = {
    where(field: string, op: string, value: unknown) {
      whereCalls.push({ field, op, value });
      return query;
    },
    aggregate(aggs: Record<string, unknown>) {
      aggregationsPassed = aggs;
      return {
        get: vi.fn().mockResolvedValue({
          data: () => snapData,
        }),
      };
    },
  };

  return {
    query,
    whereCalls,
    getAggregationsPassed: () => aggregationsPassed,
  };
}

describe('runFirestoreAggregate', () => {
  // --- happy path ---

  it('translates count/sum/avg into AggregateField.count/sum/average', async () => {
    // The mocked snapshot returns concrete numbers — we're asserting the
    // translation maps each spec entry to the right AggregateField factory
    // and surfaces the snapshot data unchanged for non-empty results.
    const { query, getAggregationsPassed } = makeMockQuery({
      n: 4,
      total: 100,
      mean: 25,
    });

    const out = await runFirestoreAggregate(
      query,
      {
        n: { op: 'count' },
        total: { op: 'sum', field: 'data.price' },
        mean: { op: 'avg', field: 'data.price' },
      },
      [],
      { edition: 'standard' },
    );

    expect(out).toEqual({ n: 4, total: 100, mean: 25 });

    const aggs = getAggregationsPassed();
    expect(aggs).not.toBeNull();
    // Each value is an AggregateField subtype produced by the matching
    // factory call. We can't easily assert the underlying field path
    // (it's encapsulated in the SDK), but we can assert the alias map
    // shape and that each is an AggregateField instance.
    expect(Object.keys(aggs!)).toEqual(['n', 'total', 'mean']);
    expect(aggs!.n).toBeInstanceOf(AggregateField);
    expect(aggs!.total).toBeInstanceOf(AggregateField);
    expect(aggs!.mean).toBeInstanceOf(AggregateField);
  });

  it('applies firegraph filters to the base query in order', async () => {
    const { query, whereCalls } = makeMockQuery({ n: 0 });

    await runFirestoreAggregate(
      query,
      { n: { op: 'count' } },
      [
        { field: 'aType', op: '==', value: 'tour' },
        { field: 'data.status', op: '==', value: 'active' },
      ],
      { edition: 'enterprise' },
    );

    // applyFiltersToQuery + the helper share the same `where()` loop.
    expect(whereCalls).toEqual([
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.status', op: '==', value: 'active' },
    ]);
  });

  // --- empty-set semantics ---

  it('resolves null SUM/MIN/MAX results to 0 (Firestore returns null for empty SUM)', async () => {
    // Firestore's classic Query.aggregate returns null for sum/avg over an
    // empty set. The helper resolves SUM null → 0 (well-defined) and AVG
    // null → NaN (mathematically undefined). COUNT is never null.
    const { query } = makeMockQuery({ n: 0, total: null });

    const out = await runFirestoreAggregate(
      query,
      {
        n: { op: 'count' },
        total: { op: 'sum', field: 'data.price' },
      },
      [],
      { edition: 'standard' },
    );

    expect(out.n).toBe(0);
    expect(out.total).toBe(0);
  });

  it('resolves null AVG result to NaN (mathematically undefined for empty input)', async () => {
    const { query } = makeMockQuery({ mean: null });

    const out = await runFirestoreAggregate(
      query,
      { mean: { op: 'avg', field: 'data.price' } },
      [],
      { edition: 'standard' },
    );

    expect(Number.isNaN(out.mean)).toBe(true);
  });

  // --- error path ---

  it('throws UNSUPPORTED_AGGREGATE on min with the Standard edition label', async () => {
    const { query } = makeMockQuery({});
    await expect(
      runFirestoreAggregate(query, { lo: { op: 'min', field: 'data.price' } }, [], {
        edition: 'standard',
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AGGREGATE',
      message: expect.stringContaining('Firestore Standard'),
    });
  });

  it('throws UNSUPPORTED_AGGREGATE on max with the Enterprise edition label', async () => {
    // Both editions currently route through the classic Query.aggregate API
    // which doesn't expose min/max. Enterprise *could* support them via
    // pipelines (deferred). Until then both editions reject identically;
    // the message names the edition so diagnostics are accurate.
    const { query } = makeMockQuery({});
    await expect(
      runFirestoreAggregate(query, { hi: { op: 'max', field: 'data.price' } }, [], {
        edition: 'enterprise',
      }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_AGGREGATE',
      message: expect.stringContaining('Firestore Enterprise'),
    });
  });

  it('throws INVALID_QUERY when the spec is empty', async () => {
    const { query } = makeMockQuery({});
    await expect(
      runFirestoreAggregate(query, {}, [], { edition: 'standard' }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('at least one aggregation'),
    });
  });

  it('throws INVALID_QUERY when count carries a stray field (typo guard)', async () => {
    // The count op operates on rows and ignores any field expression.
    // Silently accepting `field` would mask user typos like
    // `{ n: { op: 'count', field: 'data.price' } }` (cribbed from a sum
    // spec) and produce a misleading row count. Reject with a clear
    // message so the bad spec surfaces immediately.
    const { query } = makeMockQuery({});
    await expect(
      runFirestoreAggregate(query, { n: { op: 'count', field: 'data.price' } }, [], {
        edition: 'standard',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining("'count' must not specify a field"),
    });
  });

  it('throws INVALID_QUERY when sum/avg is missing a field', async () => {
    const { query } = makeMockQuery({});
    await expect(
      runFirestoreAggregate(query, { s: { op: 'sum' } as { op: 'sum' } }, [], {
        edition: 'standard',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining("'sum' requires a field"),
    });

    await expect(
      runFirestoreAggregate(query, { a: { op: 'avg' } as { op: 'avg' } }, [], {
        edition: 'enterprise',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining("'avg' requires a field"),
    });
  });
});

describe('applyFiltersToQuery', () => {
  it('returns the base query unchanged when no filters are supplied', () => {
    // A no-op base case the helper depends on — without it, an unfiltered
    // aggregate would still issue a `where()` with whatever sentinel value
    // and break the bind plan.
    const { query, whereCalls } = makeMockQuery({});
    const out = applyFiltersToQuery(query, []);
    expect(out).toBe(query);
    expect(whereCalls).toEqual([]);
  });

  it('chains where() once per filter', () => {
    const { query, whereCalls } = makeMockQuery({});
    applyFiltersToQuery(query, [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'data.price', op: '>=', value: 25 },
    ]);
    expect(whereCalls).toHaveLength(2);
    expect(whereCalls[0]).toMatchObject({ field: 'aType', op: '==' });
    expect(whereCalls[1]).toMatchObject({ field: 'data.price', op: '>=' });
  });
});
