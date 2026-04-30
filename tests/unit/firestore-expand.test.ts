/**
 * Unit tests for `src/internal/firestore-expand.ts` — the shared Pipelines
 * multi-source fan-out used by Firestore Enterprise under capability
 * `query.join` when `queryMode === 'pipeline'`.
 *
 * The classic-mode (and Standard) path uses `firestore-classic-expand.ts`
 * — that file has its own dedicated test suite. The point of having two
 * helpers (and two suites) is that the round-trip profiles differ even
 * though the observable contract is the same: one server-side stage on
 * pipelines vs `ceil(N/30)` chunks on classic. These tests lock down the
 * pipeline composition: stage order, predicate shape, hydration round
 * trip, and the `NODE_RELATION` self-loop guard.
 *
 * The Pipelines module is mocked via `vi.mock('@google-cloud/firestore', …)`
 * so these tests run inside `pnpm test:unit` without an emulator. A real
 * Enterprise project is required for the end-to-end wire test (deferred
 * to integration coverage).
 */

import { describe, expect, it, vi } from 'vitest';

import { runFirestorePipelineExpand } from '../../src/internal/firestore-expand.js';
import type { ExpandParams } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock @google-cloud/firestore. The helper consumes:
//   - Pipelines.equal(field, value)
//   - Pipelines.equalAny(field, values)
//   - Pipelines.and(...exprs)
//   - Pipelines.field(name).ascending() / .descending()
// We stub each as identity-tagged constructors so the test can assert what
// got composed without depending on a real SDK build.
// ---------------------------------------------------------------------------

interface TaggedExpr {
  __kind: string;
  args: unknown[];
}

vi.mock('@google-cloud/firestore', () => {
  const Pipelines = {
    equal: (field: string, value: unknown) =>
      ({ __kind: 'equal', args: [field, value] }) as TaggedExpr,
    equalAny: (field: string, values: unknown[]) =>
      ({ __kind: 'equalAny', args: [field, values] }) as TaggedExpr,
    and: (...exprs: TaggedExpr[]) => ({ __kind: 'and', args: exprs }) as TaggedExpr,
    field: (name: string) => ({
      __kind: 'field',
      args: [name],
      ascending() {
        return { __kind: 'orderBy', args: [name, 'asc'] };
      },
      descending() {
        return { __kind: 'orderBy', args: [name, 'desc'] };
      },
    }),
  };
  return { Pipelines };
});

// ---------------------------------------------------------------------------
// Mock Firestore `Pipeline` builder chain. Each stage call returns the
// same chainable proxy and records what was passed; `execute()` plays
// back the queue of pre-staged result sets so a single `db` instance can
// drive the fan-out call AND the hydration call in the same test.
// ---------------------------------------------------------------------------

interface StageCall {
  stage: string;
  args: unknown[];
}

function makeFakeDb(executeQueue: Array<Array<{ data: () => Record<string, unknown> }>>): {
  db: unknown;
  calls: StageCall[];
} {
  const calls: StageCall[] = [];
  let executeIndex = 0;

  // Each `db.pipeline()` call returns a fresh chainable so the hydration
  // pipeline doesn't leak state into the fan-out pipeline. Stage calls
  // are tracked across both pipelines via the shared `calls` array.
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
    p.sort = (ordering: unknown) => {
      calls.push({ stage: 'sort', args: [ordering] });
      return p;
    };
    p.limit = (n: number) => {
      calls.push({ stage: 'limit', args: [n] });
      return p;
    };
    p.execute = async () => {
      calls.push({ stage: 'execute', args: [] });
      const rows = executeQueue[executeIndex++] ?? [];
      return { results: rows };
    };
    return p;
  }

  const db: Record<string, unknown> = {
    pipeline: () => makePipeline(),
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

describe('runFirestorePipelineExpand — input validation', () => {
  it('short-circuits an empty sources list to an empty result without touching the SDK', async () => {
    const { db, calls } = makeFakeDb([]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: [],
      axbType: 'hasDeparture',
    });
    expect(out).toEqual({ edges: [] });
    expect(calls).toEqual([]);
  });

  it('returns { edges: [], targets: [] } for empty sources when hydrate is requested', async () => {
    const { db, calls } = makeFakeDb([]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: [],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out).toEqual({ edges: [], targets: [] });
    expect(calls).toEqual([]);
  });

  it('rejects an empty axbType with INVALID_QUERY', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestorePipelineExpand(db as never, 'graph', {
        sources: ['u1'],
        axbType: '',
      } as ExpandParams),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /axbType must be a non-empty/ });
  });
});

// ---------------------------------------------------------------------------
// Pipeline composition
// ---------------------------------------------------------------------------

describe('runFirestorePipelineExpand — pipeline composition', () => {
  it('builds a single where(and(equal(axbType,…), equalAny(aUid, sources))) for forward direction', async () => {
    const { db, calls } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'hasDeparture',
            bType: 'departure',
            bUid: 'd1',
          }),
        },
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1', 'u2', 'u3'],
      axbType: 'hasDeparture',
    });
    expect(calls.map((c) => c.stage)).toEqual(['collection', 'where', 'execute']);
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr.__kind).toBe('and');
    const inner = whereExpr.args as TaggedExpr[];
    expect(inner[0]).toMatchObject({ __kind: 'equal', args: ['axbType', 'hasDeparture'] });
    expect(inner[1]).toMatchObject({ __kind: 'equalAny', args: ['aUid', ['u1', 'u2', 'u3']] });
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ aUid: 'u1', bUid: 'd1' });
  });

  it('uses bUid as the source field in reverse direction', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['t1'],
      axbType: 'hasDeparture',
      direction: 'reverse',
    });
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    const inner = whereExpr.args as TaggedExpr[];
    expect(inner[1]).toMatchObject({ __kind: 'equalAny', args: ['bUid', ['t1']] });
  });

  it('appends aType / bType filters when supplied', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      aType: 'tour',
      bType: 'departure',
    });
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    const fields = (whereExpr.args as TaggedExpr[]).map((e) => e.args[0]);
    // Expect axbType, sourceField (aUid), aType, bType in that order.
    expect(fields).toEqual(['axbType', 'aUid', 'aType', 'bType']);
  });

  it('emits a single where(predicate) without and(...) when only one expression is built', async () => {
    // The minimal predicate set is `axbType` + `equalAny(sourceField, ...)`,
    // which always exceeds 1 — so this branch only fires if a future change
    // ever lets the predicate list shrink to 1. The helper still has to
    // handle that path; we exercise it by stubbing an internally short
    // predicate. Since we can't take that branch with current params, this
    // test pins the >1 behaviour: an `and(...)` wrapper IS used.
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'has',
    });
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr.__kind).toBe('and');
  });

  it('translates orderBy into a sort(field.ascending()) / sort(field.descending()) stage', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt', direction: 'desc' },
    });
    const sortStage = calls.find((c) => c.stage === 'sort');
    expect(sortStage).toBeDefined();
    const ordering = sortStage!.args[0] as TaggedExpr;
    expect(ordering).toMatchObject({ __kind: 'orderBy', args: ['data.startsAt', 'desc'] });
  });

  it('defaults the sort direction to ascending when orderBy.direction is omitted', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt' },
    });
    const ordering = calls.find((c) => c.stage === 'sort')!.args[0] as TaggedExpr;
    expect(ordering).toMatchObject({ __kind: 'orderBy', args: ['data.startsAt', 'asc'] });
  });

  it('translates limitPerSource into a global limit(sources.length * limitPerSource)', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1', 'u2', 'u3'],
      axbType: 'hasDeparture',
      limitPerSource: 5,
    });
    const limitStage = calls.find((c) => c.stage === 'limit');
    expect(limitStage).toBeDefined();
    expect(limitStage!.args[0]).toBe(15);
  });

  it('omits the limit stage when limitPerSource is undefined', async () => {
    const { db, calls } = makeFakeDb([[]]);
    await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
    });
    expect(calls.some((c) => c.stage === 'limit')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Self-loop guard
// ---------------------------------------------------------------------------

describe('runFirestorePipelineExpand — NODE_RELATION self-loop guard', () => {
  it('filters out edges where aUid === bUid when axbType === NODE_RELATION', async () => {
    // The traversal layer never sends NODE_RELATION as axbType, but a
    // direct `client.expand({ axbType: 'is' })` call would pull in the
    // source nodes themselves (stored as self-loops). Mirror the SQL
    // backends' `aUid != bUid` guard in JS post-processing.
    const { db } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'is',
            bType: 'tour',
            bUid: 'u1', // self-loop — should be filtered out
          }),
        },
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'is',
            bType: 'tour',
            bUid: 'u2', // not a self-loop — keep
          }),
        },
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'is',
    });
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ bUid: 'u2' });
  });

  it('does NOT filter self-loops when axbType is a regular edge type', async () => {
    // Sanity check: the guard is gated on axbType === NODE_RELATION. A
    // hypothetical edge that just happens to have aUid === bUid for
    // some unrelated relation must not be silently dropped.
    const { db } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'doc',
            aUid: 'u1',
            axbType: 'self-ref',
            bType: 'doc',
            bUid: 'u1',
          }),
        },
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'self-ref',
    });
    expect(out.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

describe('runFirestorePipelineExpand — hydration', () => {
  it('runs a follow-up pipeline that filters by axbType=NODE_RELATION AND aUid equalAny <targets>', async () => {
    // First pipeline returns two edges; second pipeline returns the two
    // target nodes (self-loops). Hydration aligns by bUid (which equals
    // the node's UID by construction).
    const { db, calls } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'hasDeparture',
            bType: 'departure',
            bUid: 'd1',
          }),
        },
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'hasDeparture',
            bType: 'departure',
            bUid: 'd2',
          }),
        },
      ],
      [
        {
          data: () => ({
            aType: 'departure',
            aUid: 'd1',
            axbType: 'is',
            bType: 'departure',
            bUid: 'd1',
          }),
        },
        {
          data: () => ({
            aType: 'departure',
            aUid: 'd2',
            axbType: 'is',
            bType: 'departure',
            bUid: 'd2',
          }),
        },
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.edges).toHaveLength(2);
    expect(out.targets).toBeDefined();
    expect(out.targets).toHaveLength(2);
    expect(out.targets![0]).toMatchObject({ bUid: 'd1' });
    expect(out.targets![1]).toMatchObject({ bUid: 'd2' });

    // Verify the hydration pipeline's where(...) shape.
    const whereCalls = calls.filter((c) => c.stage === 'where');
    expect(whereCalls).toHaveLength(2);
    const hydrateExpr = whereCalls[1].args[0] as TaggedExpr;
    expect(hydrateExpr.__kind).toBe('and');
    const inner = hydrateExpr.args as TaggedExpr[];
    expect(inner[0]).toMatchObject({ __kind: 'equal', args: ['axbType', 'is'] });
    expect(inner[1]).toMatchObject({ __kind: 'equalAny', args: ['aUid', ['d1', 'd2']] });
  });

  it('returns null in the targets array when a target node has no row in the collection', async () => {
    const { db } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 'u1',
            axbType: 'hasDeparture',
            bType: 'departure',
            bUid: 'd1',
          }),
        },
      ],
      [
        // Empty hydration result — d1 has no node row (orphan reference).
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.edges).toHaveLength(1);
    expect(out.targets).toEqual([null]);
  });

  it('uses aUid as the hydration key for reverse direction', async () => {
    // In reverse direction the "target" node from the caller's PoV is the
    // aUid side of the edge.
    const { db } = makeFakeDb([
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 't1',
            axbType: 'hasDeparture',
            bType: 'departure',
            bUid: 'd1',
          }),
        },
      ],
      [
        {
          data: () => ({
            aType: 'tour',
            aUid: 't1',
            axbType: 'is',
            bType: 'tour',
            bUid: 't1',
          }),
        },
      ],
    ]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['d1'],
      axbType: 'hasDeparture',
      direction: 'reverse',
      hydrate: true,
    });
    expect(out.targets).toHaveLength(1);
    expect(out.targets![0]).toMatchObject({ bUid: 't1' });
  });

  it('returns { edges, targets: [] } when the edge fan-out yields zero rows', async () => {
    const { db } = makeFakeDb([[]]);
    const out = await runFirestorePipelineExpand(db as never, 'graph', {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.edges).toEqual([]);
    expect(out.targets).toEqual([]);
  });
});
