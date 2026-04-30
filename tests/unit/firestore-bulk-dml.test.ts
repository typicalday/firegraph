/**
 * Unit tests for `src/internal/firestore-bulk-dml.ts` — the Pipelines DML
 * helpers used by Firestore Enterprise under capability `query.dml` when
 * the backend is constructed with `previewDml: true` (Phase 13b).
 *
 * The Pipeline `delete()` and `update(transformedFields)` stages are
 * `@beta` in `@google-cloud/firestore@8.5.0`, so end-to-end coverage
 * lives in gated integration tests against a real Enterprise instance.
 * These unit tests pin the helper-side composition: filter translation,
 * stage order, deleteField()-sentinel rejection, the empty-filter
 * defense-in-depth check, and the `updatedAt` stamp on `bulkUpdate`.
 *
 * The Pipelines module + `Timestamp` class are mocked via
 * `vi.mock('@google-cloud/firestore', …)` so this suite runs inside
 * `pnpm test:unit` without an emulator. Pattern matches
 * `tests/unit/firestore-expand.test.ts` and
 * `tests/unit/firestore-fulltext.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { deleteField } from '../../src/index.js';
import {
  runFirestorePipelineDelete,
  runFirestorePipelineUpdate,
} from '../../src/internal/firestore-bulk-dml.js';
import type { QueryFilter } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock @google-cloud/firestore. The helper consumes:
//   - Pipelines.equal / equalAny / notEqual / lessThan / lessThanOrEqual /
//     greaterThan / greaterThanOrEqual / notEqualAny / arrayContains /
//     arrayContainsAny  (the full filter-op vocabulary)
//   - Pipelines.and(...exprs)
//   - Pipelines.constant(value).as(alias) → AliasedExpression
//   - Timestamp.now()
// We stub each as identity-tagged constructors so tests can introspect
// what got composed without depending on a real SDK build.
// ---------------------------------------------------------------------------

interface TaggedExpr {
  __kind: string;
  args: unknown[];
}

interface TaggedConst extends TaggedExpr {
  as: (alias: string) => TaggedAlias;
}

interface TaggedAlias {
  __kind: 'alias';
  alias: string;
  expr: TaggedConst;
}

vi.mock('@google-cloud/firestore', () => {
  const filterFactory =
    (kind: string) =>
    (field: string, value: unknown): TaggedExpr => ({ __kind: kind, args: [field, value] });

  const Pipelines = {
    equal: filterFactory('equal'),
    notEqual: filterFactory('notEqual'),
    lessThan: filterFactory('lessThan'),
    lessThanOrEqual: filterFactory('lessThanOrEqual'),
    greaterThan: filterFactory('greaterThan'),
    greaterThanOrEqual: filterFactory('greaterThanOrEqual'),
    equalAny: (field: string, values: unknown[]): TaggedExpr => ({
      __kind: 'equalAny',
      args: [field, values],
    }),
    notEqualAny: (field: string, values: unknown[]): TaggedExpr => ({
      __kind: 'notEqualAny',
      args: [field, values],
    }),
    arrayContains: filterFactory('arrayContains'),
    arrayContainsAny: (field: string, values: unknown[]): TaggedExpr => ({
      __kind: 'arrayContainsAny',
      args: [field, values],
    }),
    and: (...exprs: TaggedExpr[]): TaggedExpr => ({ __kind: 'and', args: exprs }),
    constant: (value: unknown): TaggedConst => {
      const expr: TaggedConst = {
        __kind: 'constant',
        args: [value],
        as: (alias: string): TaggedAlias => ({ __kind: 'alias', alias, expr }),
      };
      return expr;
    },
  };
  const Timestamp = {
    now: () => ({ __kind: 'timestamp', value: 'NOW' }),
  };
  return { Pipelines, Timestamp };
});

// ---------------------------------------------------------------------------
// Mock Firestore Pipeline builder. Records each stage call so tests can
// inspect the composed pipeline. `delete()` and `update()` are recorded
// alongside `where`/`collection` so stage-order assertions stay simple.
// `execute()` returns a pre-staged result count.
// ---------------------------------------------------------------------------

interface StageCall {
  stage: string;
  args: unknown[];
}

function makeFakeDb(executeQueue: number[]): { db: unknown; calls: StageCall[] } {
  const calls: StageCall[] = [];
  let executeIndex = 0;

  function makePipeline(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    p.collection = (path: string) => {
      calls.push({ stage: 'collection', args: [path] });
      return p;
    };
    p.where = (expr: unknown) => {
      calls.push({ stage: 'where', args: [expr] });
      return p;
    };
    p.delete = () => {
      calls.push({ stage: 'delete', args: [] });
      return p;
    };
    p.update = (transforms: unknown) => {
      calls.push({ stage: 'update', args: [transforms] });
      return p;
    };
    p.execute = async () => {
      calls.push({ stage: 'execute', args: [] });
      const count = executeQueue[executeIndex++] ?? 0;
      // Build a `results` array of `count` placeholder entries — only
      // `.length` is consumed by the helper.
      return { results: Array.from({ length: count }, (_, i) => ({ id: `r${i}` })) };
    };
    return p;
  }

  const db = { pipeline: () => makePipeline() };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// runFirestorePipelineDelete — input validation
// ---------------------------------------------------------------------------

describe('runFirestorePipelineDelete — input validation', () => {
  it('rejects empty filter list with INVALID_QUERY (defense-in-depth against full-collection wipe)', async () => {
    const { db, calls } = makeFakeDb([]);
    await expect(runFirestorePipelineDelete(db as never, 'graph', [])).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /at least one filter/,
    });
    expect(calls).toEqual([]);
  });

  it('rejects unsupported filter ops with INVALID_QUERY', async () => {
    const { db } = makeFakeDb([0]);
    const filters = [{ field: 'foo', op: 'weird-op' as never, value: 1 } as QueryFilter];
    await expect(runFirestorePipelineDelete(db as never, 'graph', filters)).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /unsupported filter op/,
    });
  });
});

// ---------------------------------------------------------------------------
// runFirestorePipelineDelete — pipeline composition
// ---------------------------------------------------------------------------

describe('runFirestorePipelineDelete — pipeline composition', () => {
  it('emits collection → where → delete → execute (single filter, no and-wrapper)', async () => {
    const { db, calls } = makeFakeDb([3]);
    const result = await runFirestorePipelineDelete(db as never, 'graph', [
      { field: 'aType', op: '==', value: 'tour' },
    ]);
    expect(calls.map((c) => c.stage)).toEqual(['collection', 'where', 'delete', 'execute']);
    expect(calls[0].args[0]).toBe('graph');
    const where = calls[1].args[0] as TaggedExpr;
    expect(where).toMatchObject({ __kind: 'equal', args: ['aType', 'tour'] });
    expect(result).toEqual({ deleted: 3, batches: 1, errors: [] });
  });

  it('wraps multiple filters in and(...) preserving filter order', async () => {
    const { db, calls } = makeFakeDb([5]);
    await runFirestorePipelineDelete(db as never, 'graph', [
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'aUid', op: 'in', value: ['u1', 'u2'] },
    ]);
    const where = calls[1].args[0] as TaggedExpr;
    expect(where.__kind).toBe('and');
    const inner = where.args as TaggedExpr[];
    expect(inner.map((e) => e.__kind)).toEqual(['equal', 'equal', 'equalAny']);
    expect(inner[2].args[1]).toEqual(['u1', 'u2']);
  });

  it('returns deleted: 0 when execute reports no affected rows', async () => {
    const { db } = makeFakeDb([0]);
    const out = await runFirestorePipelineDelete(db as never, 'graph', [
      { field: 'aType', op: '==', value: 'orphan' },
    ]);
    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
  });

  it('translates the full filter-op vocabulary (smoke test)', async () => {
    const { db, calls } = makeFakeDb([1]);
    await runFirestorePipelineDelete(db as never, 'graph', [
      { field: 'a', op: '==', value: 1 },
      { field: 'b', op: '!=', value: 2 },
      { field: 'c', op: '<', value: 3 },
      { field: 'd', op: '<=', value: 4 },
      { field: 'e', op: '>', value: 5 },
      { field: 'f', op: '>=', value: 6 },
      { field: 'g', op: 'in', value: [7, 8] },
      { field: 'h', op: 'not-in', value: [9, 10] },
      { field: 'i', op: 'array-contains', value: 11 },
      { field: 'j', op: 'array-contains-any', value: [12] },
    ]);
    const inner = (calls[1].args[0] as TaggedExpr).args as TaggedExpr[];
    expect(inner.map((e) => e.__kind)).toEqual([
      'equal',
      'notEqual',
      'lessThan',
      'lessThanOrEqual',
      'greaterThan',
      'greaterThanOrEqual',
      'equalAny',
      'notEqualAny',
      'arrayContains',
      'arrayContainsAny',
    ]);
  });
});

// ---------------------------------------------------------------------------
// runFirestorePipelineUpdate — input validation
// ---------------------------------------------------------------------------

describe('runFirestorePipelineUpdate — input validation', () => {
  it('rejects empty filter list with INVALID_QUERY', async () => {
    const { db, calls } = makeFakeDb([]);
    await expect(
      runFirestorePipelineUpdate(db as never, 'graph', [], { data: { foo: 'bar' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /at least one filter/,
    });
    expect(calls).toEqual([]);
  });

  it('rejects empty patch.data with INVALID_QUERY (would only stamp updatedAt)', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestorePipelineUpdate(
        db as never,
        'graph',
        [{ field: 'aType', op: '==', value: 'tour' }],
        { data: {} },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /no field updates/,
    });
  });

  it('rejects deleteField() sentinels with INVALID_QUERY (preview DML has no delete-transform)', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestorePipelineUpdate(
        db as never,
        'graph',
        [{ field: 'aType', op: '==', value: 'tour' }],
        { data: { stale: deleteField() } },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: /preview Pipeline DML does not support deleteField/,
    });
  });
});

// ---------------------------------------------------------------------------
// runFirestorePipelineUpdate — pipeline composition
// ---------------------------------------------------------------------------

describe('runFirestorePipelineUpdate — pipeline composition', () => {
  it('emits collection → where → update([…transforms]) → execute', async () => {
    const { db, calls } = makeFakeDb([7]);
    const result = await runFirestorePipelineUpdate(
      db as never,
      'graph',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { data: { status: 'archived' } },
    );
    expect(calls.map((c) => c.stage)).toEqual(['collection', 'where', 'update', 'execute']);
    expect(result).toEqual({ deleted: 7, batches: 1, errors: [] });
  });

  it('flattens nested patches into one constant(value).as(dotted-path) per leaf', async () => {
    const { db, calls } = makeFakeDb([1]);
    await runFirestorePipelineUpdate(
      db as never,
      'graph',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { data: { profile: { name: 'A', age: 30 }, active: true } },
    );
    const transforms = calls[2].args[0] as TaggedAlias[];
    // Three leaves from the patch + one updatedAt stamp = 4 transforms
    expect(transforms).toHaveLength(4);
    const aliases = transforms.map((t) => t.alias);
    // updatedAt must be the last transform; patch leaves come first in
    // flattenPatch order. The ordering of `profile.name` vs `profile.age`
    // matches insertion order from `flattenPatch` (which mirrors
    // Object.keys), so we assert the set rather than positional order
    // for the leaves.
    expect(aliases).toEqual(
      expect.arrayContaining(['data.profile.name', 'data.profile.age', 'data.active']),
    );
    expect(aliases[aliases.length - 1]).toBe('updatedAt');

    // Each leaf transform wraps a Pipelines.constant(...) of the literal value.
    const byAlias = new Map(transforms.map((t) => [t.alias, t]));
    expect(byAlias.get('data.profile.name')!.expr).toMatchObject({
      __kind: 'constant',
      args: ['A'],
    });
    expect(byAlias.get('data.profile.age')!.expr).toMatchObject({
      __kind: 'constant',
      args: [30],
    });
    expect(byAlias.get('data.active')!.expr).toMatchObject({
      __kind: 'constant',
      args: [true],
    });
  });

  it('stamps updatedAt with Timestamp.now() as the trailing transform', async () => {
    const { db, calls } = makeFakeDb([1]);
    await runFirestorePipelineUpdate(
      db as never,
      'graph',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { data: { foo: 'bar' } },
    );
    const transforms = calls[2].args[0] as TaggedAlias[];
    const stamp = transforms[transforms.length - 1];
    expect(stamp.alias).toBe('updatedAt');
    expect(stamp.expr.args[0]).toEqual({ __kind: 'timestamp', value: 'NOW' });
  });

  it('preserves array values verbatim (arrays are terminal in flattenPatch)', async () => {
    const { db, calls } = makeFakeDb([1]);
    await runFirestorePipelineUpdate(
      db as never,
      'graph',
      [{ field: 'aType', op: '==', value: 'tour' }],
      { data: { tags: ['a', 'b', 'c'] } },
    );
    const transforms = calls[2].args[0] as TaggedAlias[];
    const byAlias = new Map(transforms.map((t) => [t.alias, t]));
    // One transform for `data.tags` carrying the whole array, plus updatedAt.
    expect(byAlias.get('data.tags')!.expr).toMatchObject({
      __kind: 'constant',
      args: [['a', 'b', 'c']],
    });
  });

  it('returns deleted: 0 when execute reports no affected rows', async () => {
    const { db } = makeFakeDb([0]);
    const out = await runFirestorePipelineUpdate(
      db as never,
      'graph',
      [{ field: 'aType', op: '==', value: 'no-match' }],
      { data: { foo: 'bar' } },
    );
    expect(out).toEqual({ deleted: 0, batches: 1, errors: [] });
  });
});
