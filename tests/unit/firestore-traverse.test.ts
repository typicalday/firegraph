/**
 * Unit tests for `runFirestoreEngineTraversal` — the engine-traversal
 * executor that compiles an `EngineTraversalParams` spec into a single
 * nested-Pipeline call against `@google-cloud/firestore@8.5.0`'s typed
 * Pipelines surface.
 *
 * The compiler is exercised in `firestore-traverse-compiler.test.ts`;
 * this file pins the *executor*'s tree-decode contract:
 *
 *   - 1-hop result decoding: rows surface as `hops[0].edges`,
 *     `sourceCount` reflects the input source count
 *   - 2-hop nested array flattening: `hop_0_children` arrays on each
 *     parent row become `hops[1].edges`
 *   - scaffolding stripping: `hop_{depth}_children` is removed from
 *     each returned record so the shape matches `findEdges` /
 *     `expand` output
 *   - dedup on `bUid` for forward hops, `aUid` for reverse hops
 *   - NODE_RELATION self-loop guard: `aUid === bUid` rows for the
 *     `'is'` relation are filtered out (mirrors `firestore-expand.ts`)
 *   - empty-sources short-circuit: never dispatches a pipeline
 *   - ineligible spec → `UNSUPPORTED_OPERATION` error
 *
 * The `@google-cloud/firestore` module is mocked at the test-file level
 * so the executor's lazy-imported `Pipelines` static helpers and the
 * supplied fake `db.pipeline()` chain produce predictable, inspectable
 * output without needing a real Firestore instance.
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google-cloud/firestore so the executor's lazy `getPipelines()`
// returns a Pipelines static object whose helpers tag their inputs as
// inert plain objects. The fake `db.pipeline()` chain is constructed
// per-test (below) — it doesn't need to interpret the tagged exprs,
// only forward them through the chainable shape.
// ---------------------------------------------------------------------------
vi.mock('@google-cloud/firestore', () => {
  const tag = (kind: string, ...args: unknown[]) => ({ __tag: kind, args });
  const fieldExpr = (name: string) => ({
    __tag: 'field',
    name,
    as: (alias: string) => ({ __tag: 'aliased', source: name, alias }),
    ascending: () => ({ __tag: 'ascending', name }),
    descending: () => ({ __tag: 'descending', name }),
  });
  return {
    Pipelines: {
      equal: (f: unknown, v: unknown) => tag('equal', f, v),
      equalAny: (f: unknown, v: unknown) => tag('equalAny', f, v),
      and: (...exprs: unknown[]) => tag('and', ...exprs),
      field: fieldExpr,
      variable: (name: string) => tag('variable', name),
    },
  };
});

// Imported AFTER `vi.mock` so the mocked module is in place before the
// executor's lazy-import sees it.
import type { Firestore } from '@google-cloud/firestore';

import { runFirestoreEngineTraversal } from '../../src/internal/firestore-traverse.js';

// ---------------------------------------------------------------------------
// Fake `db` whose `pipeline()` returns a chainable stub. Only the very
// first pipeline created in a call has `execute()` invoked on it (the
// outer-most pipeline). Sub-pipelines have `toArrayExpression()` called
// on them, which the stub handles. We hand the canned root rows to the
// first pipeline so subsequent inner pipelines don't accidentally
// override them.
// ---------------------------------------------------------------------------

interface FakePipeline {
  _stages: Array<[string, unknown]>;
  collection: (path: string) => FakePipeline;
  where: (expr: unknown) => FakePipeline;
  limit: (n: number) => FakePipeline;
  sort: (o: unknown) => FakePipeline;
  define: (...defs: unknown[]) => FakePipeline;
  addFields: (...fields: unknown[]) => FakePipeline;
  toArrayExpression: () => { as: (alias: string) => unknown };
  execute: () => Promise<{ results: Array<{ data: () => unknown }> }>;
}

function createPipeline(rootData?: Array<Record<string, unknown>>): FakePipeline {
  const stages: Array<[string, unknown]> = [];
  const p: FakePipeline = {
    _stages: stages,
    collection(path) {
      stages.push(['collection', path]);
      return p;
    },
    where(expr) {
      stages.push(['where', expr]);
      return p;
    },
    limit(n) {
      stages.push(['limit', n]);
      return p;
    },
    sort(o) {
      stages.push(['sort', o]);
      return p;
    },
    define(...defs) {
      stages.push(['define', defs]);
      return p;
    },
    addFields(...fields) {
      stages.push(['addFields', fields]);
      return p;
    },
    toArrayExpression() {
      return { as: (alias: string) => ({ __tag: 'arrayAs', alias }) };
    },
    async execute() {
      return {
        results: (rootData ?? []).map((d) => ({ data: () => d })),
      };
    },
  };
  return p;
}

function createFakeDb(rootData: Array<Record<string, unknown>>) {
  const created: FakePipeline[] = [];
  const db = {
    pipeline: () => {
      // Hand the canned rows to the FIRST pipeline only — that's the
      // outer-most one, the one whose `execute()` actually fires.
      // Inner sub-pipelines never have execute() called on them.
      const p = createPipeline(created.length === 0 ? rootData : []);
      created.push(p);
      return p;
    },
  };
  return { db: db as unknown as Firestore, created };
}

// ---------------------------------------------------------------------------
// Edge-row helper — minimum shape the executor walks. Real rows have
// `data` / `createdAt` / `updatedAt`; we include them here so the
// returned `StoredGraphRecord` type-checks if a future test asserts
// against the typed surface.
// ---------------------------------------------------------------------------

function edge(
  aUid: string,
  bUid: string,
  axbType: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    aType: 't',
    aUid,
    axbType,
    bType: 't',
    bUid,
    data: {},
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('runFirestoreEngineTraversal — single-hop tree decode', () => {
  it('returns 1-hop edges with sourceCount = sources.length and totalReads = edge count', async () => {
    const rows = [edge('a', 'b1', 'rel'), edge('a', 'b2', 'rel')];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [{ axbType: 'rel', limitPerSource: 5 }],
    });

    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].edges).toHaveLength(2);
    expect(result.hops[0].edges.map((e) => e.bUid)).toEqual(['b1', 'b2']);
    expect(result.hops[0].sourceCount).toBe(1);
    expect(result.totalReads).toBe(2);
  });
});

describe('runFirestoreEngineTraversal — multi-hop tree decode', () => {
  it('flattens 2-hop nested arrays via hop_0_children into hops[1].edges', async () => {
    // Root row has a `hop_0_children` array carrying the depth-1 edges.
    // The executor walks the array, dedupes, and packs into hops[1].edges.
    const rows = [
      edge('a', 'b1', 'r1', {
        hop_0_children: [edge('b1', 'c1', 'r2'), edge('b1', 'c2', 'r2')],
      }),
    ];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [
        { axbType: 'r1', limitPerSource: 10 },
        { axbType: 'r2', limitPerSource: 10 },
      ],
    });

    expect(result.hops).toHaveLength(2);
    expect(result.hops[0].edges).toHaveLength(1);
    expect(result.hops[0].edges[0].bUid).toBe('b1');
    expect(result.hops[1].edges.map((e) => e.bUid)).toEqual(['c1', 'c2']);
    expect(result.hops[1].sourceCount).toBe(2);
  });

  it('flattens a 3-hop deeply nested tree (hop_0_children -> hop_1_children)', async () => {
    // Each depth's children live under `hop_{depth}_children` on the
    // parent row. The executor walks recursively, depth-by-depth.
    const rows = [
      edge('a', 'b1', 'r1', {
        hop_0_children: [
          edge('b1', 'c1', 'r2', {
            hop_1_children: [edge('c1', 'd1', 'r3'), edge('c1', 'd2', 'r3')],
          }),
        ],
      }),
    ];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [
        { axbType: 'r1', limitPerSource: 10 },
        { axbType: 'r2', limitPerSource: 10 },
        { axbType: 'r3', limitPerSource: 10 },
      ],
    });

    expect(result.hops).toHaveLength(3);
    expect(result.hops[0].edges.map((e) => e.bUid)).toEqual(['b1']);
    expect(result.hops[1].edges.map((e) => e.bUid)).toEqual(['c1']);
    expect(result.hops[2].edges.map((e) => e.bUid)).toEqual(['d1', 'd2']);
  });
});

describe('runFirestoreEngineTraversal — scaffolding strip', () => {
  it('removes hop_{depth}_children from every returned record', async () => {
    // The decoder pulls children out for the next-depth frontier BEFORE
    // stripping; the returned records must not carry the scaffolding key.
    const rows = [
      edge('a', 'b1', 'r1', {
        hop_0_children: [edge('b1', 'c1', 'r2')],
      }),
    ];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [
        { axbType: 'r1', limitPerSource: 10 },
        { axbType: 'r2', limitPerSource: 10 },
      ],
    });

    // Cast to a generic record-shaped type so we can probe for the
    // scaffolding field — `StoredGraphRecord` doesn't declare it.
    const hop0 = result.hops[0].edges[0] as unknown as Record<string, unknown>;
    expect(hop0.hop_0_children).toBeUndefined();
    // Hop-1 edges never had a `hop_1_children` key, but we strip
    // unconditionally — this is a depth-correctness probe.
    const hop1 = result.hops[1].edges[0] as unknown as Record<string, unknown>;
    expect(hop1.hop_1_children).toBeUndefined();
  });
});

describe('runFirestoreEngineTraversal — dedup', () => {
  it('dedupes forward hops on bUid (first occurrence wins)', async () => {
    // Two duplicate b1 rows + one b2 row → output is [b1, b2].
    const rows = [edge('a', 'b1', 'r'), edge('a', 'b1', 'r'), edge('a', 'b2', 'r')];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [{ axbType: 'r', limitPerSource: 10 }],
    });

    expect(result.hops[0].edges.map((e) => e.bUid)).toEqual(['b1', 'b2']);
  });

  it('dedupes reverse hops on aUid', async () => {
    // For reverse, the dedup key is the source-side UID (aUid). Two
    // duplicate a1 rows + one a2 row → output is [a1, a2].
    const rows = [edge('a1', 'a', 'r'), edge('a1', 'a', 'r'), edge('a2', 'a', 'r')];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [{ axbType: 'r', direction: 'reverse', limitPerSource: 10 }],
    });

    expect(result.hops[0].edges.map((e) => e.aUid)).toEqual(['a1', 'a2']);
  });
});

describe('runFirestoreEngineTraversal — NODE_RELATION self-loop guard', () => {
  it('filters rows where axbType is "is" and aUid === bUid', async () => {
    // Mirrors firestore-expand.ts's post-pass. Defensive — traverse.ts
    // never sends NODE_RELATION through engine traversal — but parity
    // with `expand()` is the right contract here.
    const rows = [
      edge('a', 'a', 'is'), // self-loop, must be filtered
      edge('a', 'b1', 'is'),
    ];
    const { db } = createFakeDb(rows);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: ['a'],
      hops: [{ axbType: 'is', limitPerSource: 10 }],
    });

    expect(result.hops[0].edges).toHaveLength(1);
    expect(result.hops[0].edges[0].bUid).toBe('b1');
  });
});

describe('runFirestoreEngineTraversal — short-circuits and errors', () => {
  it('short-circuits empty sources without dispatching a pipeline', async () => {
    // Empty sources is allowed at the compiler level (the executor
    // short-circuits with empty results); no pipeline is built so no
    // `db.pipeline()` call should happen.
    const { db, created } = createFakeDb([]);

    const result = await runFirestoreEngineTraversal(db, 'graph', {
      sources: [],
      hops: [{ axbType: 'r', limitPerSource: 10 }],
    });

    expect(result).toEqual({
      hops: [{ edges: [], sourceCount: 0 }],
      totalReads: 0,
    });
    expect(created).toHaveLength(0);
  });

  it('throws UNSUPPORTED_OPERATION when the compiler rejects the spec', async () => {
    const { db } = createFakeDb([]);

    await expect(
      runFirestoreEngineTraversal(db, 'graph', {
        sources: ['a'],
        // Zero limitPerSource is rejected by the compiler — see
        // firestore-traverse-compiler.test.ts. The executor surfaces
        // that as UNSUPPORTED_OPERATION.
        hops: [{ axbType: 'r', limitPerSource: 0 }],
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});
