/**
 * Unit tests for `src/internal/firestore-fulltext.ts` — the shared Pipelines
 * full-text search translation used by Firestore Enterprise under capability
 * `search.fullText`.
 *
 * Standard never declares the cap (FTS is an Enterprise-only product
 * feature), so this helper has exactly one in-tree backend wrapper
 * (`firestore-enterprise/backend.ts`). Covering the validation surface and
 * the Pipelines translation here locks down field-path normalisation,
 * envelope-field rejection, identifying-filter placement (after the
 * `search()` stage), and the result-decode shape.
 *
 * The Pipelines module is mocked via `vi.mock('@google-cloud/firestore', …)`
 * so these tests run inside `pnpm test:unit` without an emulator. A real
 * Enterprise project is required for the end-to-end wire test (deferred
 * to integration coverage).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  normalizeFullTextFieldPath,
  runFirestoreFullTextSearch,
} from '../../src/internal/firestore-fulltext.js';
import type { FullTextSearchParams } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Mock @google-cloud/firestore. The helper only consumes the `Pipelines`
// namespace (for `documentMatches`, `score`, `equal`, `and`) — we stub
// each as identity-tagged constructors so the test can assert what got
// composed without depending on a real SDK build.
// ---------------------------------------------------------------------------

interface TaggedExpr {
  __kind: string;
  args: unknown[];
}

vi.mock('@google-cloud/firestore', () => {
  const Pipelines = {
    documentMatches: (q: string) => ({ __kind: 'documentMatches', args: [q] }) as TaggedExpr,
    score: () => ({
      __kind: 'score',
      args: [],
      descending() {
        return { __kind: 'orderBy', args: ['score', 'desc'] };
      },
      ascending() {
        return { __kind: 'orderBy', args: ['score', 'asc'] };
      },
    }),
    equal: (field: string, value: unknown) =>
      ({ __kind: 'equal', args: [field, value] }) as TaggedExpr,
    and: (...exprs: TaggedExpr[]) => ({ __kind: 'and', args: exprs }) as TaggedExpr,
  };
  return { Pipelines };
});

// ---------------------------------------------------------------------------
// Mock Firestore `Pipeline` builder chain. Each stage call returns the
// same chainable proxy and records what was passed.
// ---------------------------------------------------------------------------

interface StageCall {
  stage: string;
  args: unknown[];
}

function makeFakeDb(rows: Array<{ data: () => Record<string, unknown> }>): {
  db: unknown;
  calls: StageCall[];
} {
  const calls: StageCall[] = [];
  const pipeline: Record<string, unknown> = {};
  pipeline.collection = (path: string) => {
    calls.push({ stage: 'collection', args: [path] });
    return pipeline;
  };
  pipeline.search = (opts: unknown) => {
    calls.push({ stage: 'search', args: [opts] });
    return pipeline;
  };
  pipeline.where = (expr: unknown) => {
    calls.push({ stage: 'where', args: [expr] });
    return pipeline;
  };
  pipeline.limit = (n: number) => {
    calls.push({ stage: 'limit', args: [n] });
    return pipeline;
  };
  pipeline.execute = async () => {
    calls.push({ stage: 'execute', args: [] });
    return { results: rows };
  };
  const db: Record<string, unknown> = {
    pipeline: () => pipeline,
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// normalizeFullTextFieldPath
// ---------------------------------------------------------------------------

describe('normalizeFullTextFieldPath', () => {
  it('rewrites bare names to data.<name>', () => {
    expect(normalizeFullTextFieldPath('title')).toBe('data.title');
  });

  it('passes through dotted data paths verbatim', () => {
    expect(normalizeFullTextFieldPath('data.title')).toBe('data.title');
    expect(normalizeFullTextFieldPath('data.body.text')).toBe('data.body.text');
  });

  it('passes through bare "data" (the entire data envelope)', () => {
    expect(normalizeFullTextFieldPath('data')).toBe('data');
  });

  it('rejects every built-in envelope field with INVALID_QUERY', () => {
    for (const field of [
      'aType',
      'aUid',
      'axbType',
      'bType',
      'bUid',
      'createdAt',
      'updatedAt',
      'v',
    ]) {
      expect(() => normalizeFullTextFieldPath(field)).toThrow(/built-in envelope field/);
    }
  });
});

// ---------------------------------------------------------------------------
// runFirestoreFullTextSearch — validation surface
// ---------------------------------------------------------------------------

describe('runFirestoreFullTextSearch — input validation', () => {
  beforeEach(() => {
    // No state to reset — the in-helper `_Pipelines` cache is module-scoped
    // and shared across tests in this file (consistent because the mock
    // is module-wide).
  });

  it('rejects an empty query string', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestoreFullTextSearch(db as never, 'graph', {
        query: '',
        limit: 10,
      } as FullTextSearchParams),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /non-empty string/ });
  });

  it('rejects a non-string query', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestoreFullTextSearch(db as never, 'graph', {
        query: 42 as unknown as string,
        limit: 10,
      } as FullTextSearchParams),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /non-empty string/ });
  });

  it('rejects a non-integer or non-positive limit', async () => {
    const { db } = makeFakeDb([]);
    for (const bad of [0, -1, 1.5, NaN]) {
      await expect(
        runFirestoreFullTextSearch(db as never, 'graph', {
          query: 'hello',
          limit: bad,
        } as FullTextSearchParams),
      ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /limit must be/ });
    }
  });

  it('rejects an envelope-field entry in `fields`', async () => {
    const { db } = makeFakeDb([]);
    await expect(
      runFirestoreFullTextSearch(db as never, 'graph', {
        query: 'hello',
        limit: 10,
        fields: ['aType'],
      } as FullTextSearchParams),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /built-in envelope field/ });
  });
});

// ---------------------------------------------------------------------------
// runFirestoreFullTextSearch — pipeline composition
// ---------------------------------------------------------------------------

describe('runFirestoreFullTextSearch — pipeline composition', () => {
  it('builds search → limit when no identifying filters are set', async () => {
    const { db, calls } = makeFakeDb([
      { data: () => ({ aType: 'doc', aUid: 'u1', axbType: 'is', bType: 'doc', bUid: 'u1' }) },
    ]);
    const out = await runFirestoreFullTextSearch(db as never, 'graph', {
      query: 'firegraph',
      limit: 5,
    });
    // Order matters: collection → search → limit → execute. No `where` stage
    // because no identifying filters were supplied.
    expect(calls.map((c) => c.stage)).toEqual(['collection', 'search', 'limit', 'execute']);
    expect(calls[0].args[0]).toBe('graph');
    expect(calls[2].args[0]).toBe(5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
  });

  it('passes documentMatches(query) and score().descending() into search opts', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreFullTextSearch(db as never, 'graph', { query: 'hello world', limit: 3 });
    const searchOpts = calls.find((c) => c.stage === 'search')?.args[0] as {
      query: TaggedExpr;
      sort: TaggedExpr;
    };
    expect(searchOpts.query).toMatchObject({ __kind: 'documentMatches', args: ['hello world'] });
    expect(searchOpts.sort).toMatchObject({ __kind: 'orderBy', args: ['score', 'desc'] });
  });

  it('places a single identifying filter into a follow-up where(equal(...))', async () => {
    // `search()` must be the first stage; identifying filters land after.
    // With exactly one filter, no `and(...)` wrapper.
    const { db, calls } = makeFakeDb([]);
    await runFirestoreFullTextSearch(db as never, 'graph', {
      query: 'hello',
      limit: 1,
      aType: 'doc',
    });
    expect(calls.map((c) => c.stage)).toEqual([
      'collection',
      'search',
      'where',
      'limit',
      'execute',
    ]);
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr).toMatchObject({ __kind: 'equal', args: ['aType', 'doc'] });
  });

  it('combines multiple identifying filters with and(...)', async () => {
    const { db, calls } = makeFakeDb([]);
    await runFirestoreFullTextSearch(db as never, 'graph', {
      query: 'hello',
      limit: 1,
      aType: 'doc',
      axbType: 'has',
      bType: 'tag',
    });
    const whereExpr = calls.find((c) => c.stage === 'where')?.args[0] as TaggedExpr;
    expect(whereExpr.__kind).toBe('and');
    // `and(equal(aType, ...), equal(axbType, ...), equal(bType, ...))` — the
    // helper rebuilds three identifying filters into one composite.
    expect((whereExpr.args as TaggedExpr[]).map((e) => e.args[0])).toEqual([
      'aType',
      'axbType',
      'bType',
    ]);
  });

  it('decodes the snapshot results into StoredGraphRecord[]', async () => {
    const { db } = makeFakeDb([
      {
        data: () => ({
          aType: 'doc',
          aUid: 'u1',
          axbType: 'is',
          bType: 'doc',
          bUid: 'u1',
          data: { title: 'Firegraph' },
        }),
      },
      {
        data: () => ({
          aType: 'doc',
          aUid: 'u2',
          axbType: 'is',
          bType: 'doc',
          bUid: 'u2',
          data: { title: 'firegraph!' },
        }),
      },
    ]);
    const out = await runFirestoreFullTextSearch(db as never, 'graph', {
      query: 'firegraph',
      limit: 5,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ aUid: 'u1' });
    expect(out[1]).toMatchObject({ aUid: 'u2' });
  });
});
