/**
 * Shared classic-API aggregate translation for both Firestore editions.
 *
 * Translates an `AggregateSpec` into a `Query.aggregate()` call using
 * `AggregateField.count() / sum() / average()`. The classic API does not
 * support `min` / `max` — those throw `UNSUPPORTED_AGGREGATE`. Backends
 * declaring `query.aggregate` are required to support at least count/sum/avg;
 * per-op limitations surface as runtime errors with a clear message.
 *
 * Both Standard and Enterprise editions can call `Query.aggregate()` directly
 * (the Enterprise pipeline `aggregate()` stage is a future optimisation that
 * would unlock min/max — Phase 11+). Until then both editions delegate to
 * this single helper, which keeps the per-edition backends thin and avoids
 * cross-subpath imports between them.
 *
 * Field paths follow the same dotted convention used elsewhere in firegraph
 * (`'data.price'`, `'data.profile.score'`). They are passed through to
 * Firestore unchanged — Firestore itself interprets `.` as a field-path
 * separator.
 */

import { AggregateField, type Query } from '@google-cloud/firestore';

import { FiregraphError } from '../errors.js';
import type { AggregateSpec, QueryFilter } from '../types.js';

/**
 * Apply the firegraph filter list to a base Firestore query. Mirrors the
 * tiny `where()` loop used by the classic adapter; kept local so the
 * aggregate path doesn't depend on adapter internals it doesn't otherwise
 * need.
 */
export function applyFiltersToQuery(base: Query, filters: QueryFilter[]): Query {
  let q = base;
  for (const f of filters) {
    q = q.where(f.field, f.op, f.value);
  }
  return q;
}

/**
 * Run an aggregate query against a base Firestore `Query`. Returns the
 * resolved numeric result keyed by alias.
 *
 * `count` is the only op that ignores `field`; everything else requires it.
 * Missing fields throw `INVALID_QUERY` so the caller sees the bad spec
 * rather than a Firestore-side error from passing `undefined` into
 * `AggregateField.sum`.
 */
export async function runFirestoreAggregate(
  base: Query,
  spec: AggregateSpec,
  filters: QueryFilter[],
  { edition }: { edition: 'standard' | 'enterprise' },
): Promise<Record<string, number>> {
  if (Object.keys(spec).length === 0) {
    throw new FiregraphError(
      'aggregate() requires at least one aggregation in the `aggregates` map.',
      'INVALID_QUERY',
    );
  }

  const filtered = applyFiltersToQuery(base, filters);
  // Firestore's `AggregateField` map values are heterogeneous — `count()`,
  // `sum(field)`, and `average(field)` each return distinct AggregateField
  // subtypes parameterized by their own input type. The library accepts a
  // record whose value union covers all three, so we type the local map
  // accordingly.
  type AnyAggField = ReturnType<typeof AggregateField.count>;
  const aggregations: Record<string, AnyAggField> = {};
  for (const [alias, { op, field }] of Object.entries(spec)) {
    if (op === 'count') {
      // Reject a stray `field` on count: counting rows never uses a column
      // expression, and silently ignoring would mask typos like
      // `{ n: { op: 'count', field: 'data.price' } }` (cribbed from a sum
      // spec). Better to surface the misuse than return a misleading row
      // count.
      if (field !== undefined) {
        throw new FiregraphError(
          `Aggregate '${alias}' op 'count' must not specify a field — ` +
            `count operates on rows, not a column expression.`,
          'INVALID_QUERY',
        );
      }
      aggregations[alias] = AggregateField.count();
      continue;
    }
    if (!field) {
      throw new FiregraphError(
        `Aggregate '${alias}' op '${op}' requires a field.`,
        'INVALID_QUERY',
      );
    }
    if (op === 'sum') {
      aggregations[alias] = AggregateField.sum(field) as unknown as AnyAggField;
    } else if (op === 'avg') {
      aggregations[alias] = AggregateField.average(field) as unknown as AnyAggField;
    } else {
      // Both editions currently route through the classic `Query.aggregate`
      // API, which exposes only count/sum/avg. Enterprise *could* expose
      // min/max via pipelines (deferred to a later phase). Until then, both
      // editions reject min/max identically — the message names the edition
      // so the diagnostic is accurate.
      const editionLabel = edition === 'enterprise' ? 'Firestore Enterprise' : 'Firestore Standard';
      throw new FiregraphError(
        `Aggregate op '${op}' is not supported on ${editionLabel}. ` +
          `Both Firestore editions support count/sum/avg via the classic Query API; ` +
          `min/max requires a backend with SQL aggregation (SQLite or DO).`,
        'UNSUPPORTED_AGGREGATE',
      );
    }
  }

  const snap = await filtered.aggregate(aggregations).get();
  const data = snap.data() as Record<string, number | null>;
  const out: Record<string, number> = {};
  for (const alias of Object.keys(spec)) {
    const v = data[alias];
    // Firestore returns `null` for sum/avg over an empty set. Surface that
    // as `0` for sum (well-defined) and `NaN` for avg (avg of empty set is
    // mathematically undefined). `count` is never null.
    if (v === null || v === undefined) {
      const op = spec[alias].op;
      out[alias] = op === 'avg' ? Number.NaN : 0;
    } else {
      out[alias] = v;
    }
  }
  return out;
}
