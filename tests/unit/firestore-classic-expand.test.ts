/**
 * Unit tests for `src/internal/firestore-classic-expand.ts` — the shared
 * classic-API multi-source fan-out used by Firestore Standard always and
 * by Firestore Enterprise when `queryMode === 'classic'`.
 *
 * The pipelines path lives at `firestore-expand.ts` with its own dedicated
 * suite. This file pins down the chunked-`'in'` strategy that Standard
 * relies on: chunking at 30 elements, parallel `Promise.all` dispatch,
 * concat + cross-chunk re-sort, total-limit slice, the NODE_RELATION
 * self-loop guard, and chunked hydration.
 *
 * The `FirestoreAdapter` interface is mocked directly — no real Firestore
 * involved. The adapter is the seam between this helper and the SDK; if
 * the contract drifts, the typecheck or this suite will catch it.
 */

import { describe, expect, it, vi } from 'vitest';

import type { FirestoreAdapter } from '../../src/internal/firestore-classic-adapter.js';
import {
  chunkUids,
  FIRESTORE_CLASSIC_IN_CHUNK_SIZE,
  runFirestoreClassicExpand,
} from '../../src/internal/firestore-classic-expand.js';
import type {
  ExpandParams,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// chunkUids — pure helper
// ---------------------------------------------------------------------------

describe('chunkUids', () => {
  it('returns an empty list when the input is empty', () => {
    expect(chunkUids([], 30)).toEqual([]);
  });

  it('returns one chunk when the input is shorter than chunkSize', () => {
    expect(chunkUids(['a', 'b', 'c'], 30)).toEqual([['a', 'b', 'c']]);
  });

  it('splits at exactly chunkSize boundaries', () => {
    const uids = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const chunks = chunkUids(uids, 30);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(30);
    expect(chunks[1]).toHaveLength(30);
    expect(chunks[0][0]).toBe('u0');
    expect(chunks[1][0]).toBe('u30');
  });

  it('produces a final partial chunk when the input is not a multiple of chunkSize', () => {
    const uids = Array.from({ length: 65 }, (_, i) => `u${i}`);
    const chunks = chunkUids(uids, 30);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toHaveLength(5);
  });

  it('throws INVALID_QUERY for non-positive chunk sizes', () => {
    expect(() => chunkUids(['a'], 0)).toThrow(/chunkSize must be positive/);
    expect(() => chunkUids(['a'], -1)).toThrow(/chunkSize must be positive/);
  });

  it('exports the documented Firestore "in" cap as the chunk size constant', () => {
    expect(FIRESTORE_CLASSIC_IN_CHUNK_SIZE).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Adapter stub — records every call
// ---------------------------------------------------------------------------

interface AdapterCall {
  filters: QueryFilter[];
  options: QueryOptions | undefined;
}

/**
 * Build a fake FirestoreAdapter where each call to `query()` is recorded
 * and the returned rows come from a per-test `respond` callback.
 */
function makeAdapter(respond: (filters: QueryFilter[]) => StoredGraphRecord[]): {
  adapter: FirestoreAdapter;
  calls: AdapterCall[];
} {
  const calls: AdapterCall[] = [];
  const adapter: FirestoreAdapter = {
    collectionPath: 'graph',
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    updateDoc: vi.fn(),
    deleteDoc: vi.fn(),
    async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
      calls.push({ filters, options });
      return respond(filters);
    },
  };
  return { adapter, calls };
}

/** Helper: build an edge row matching aUid → bUid with a sortable data field. */
function row(
  aUid: string,
  bUid: string,
  axbType = 'hasDeparture',
  data: Record<string, unknown> = {},
): StoredGraphRecord {
  return {
    aType: 'tour',
    aUid,
    axbType,
    bType: 'departure',
    bUid,
    data,
  } as StoredGraphRecord;
}

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — input validation', () => {
  it('short-circuits an empty sources list to an empty result without touching the adapter', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: [],
      axbType: 'hasDeparture',
    });
    expect(out).toEqual({ edges: [] });
    expect(calls).toEqual([]);
  });

  it('returns { edges: [], targets: [] } for empty sources when hydrate is requested', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: [],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out).toEqual({ edges: [], targets: [] });
    expect(calls).toEqual([]);
  });

  it('rejects an empty axbType with INVALID_QUERY', async () => {
    const { adapter } = makeAdapter(() => []);
    await expect(
      runFirestoreClassicExpand(adapter, {
        sources: ['u1'],
        axbType: '',
      } as ExpandParams),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: /axbType must be a non-empty/ });
  });
});

// ---------------------------------------------------------------------------
// Chunking — round-trip count + filter shape
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — chunking', () => {
  it('emits exactly one chunked query for a sources list shorter than the cap', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    await runFirestoreClassicExpand(adapter, {
      sources: ['u1', 'u2', 'u3'],
      axbType: 'hasDeparture',
    });
    expect(calls).toHaveLength(1);
    const inFilter = calls[0].filters.find((f) => f.op === 'in');
    expect(inFilter).toBeDefined();
    expect(inFilter!.value).toEqual(['u1', 'u2', 'u3']);
  });

  it('splits 100 sources into ceil(100/30) = 4 parallel chunks', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    const sources = Array.from({ length: 100 }, (_, i) => `u${i}`);
    await runFirestoreClassicExpand(adapter, { sources, axbType: 'hasDeparture' });
    expect(calls).toHaveLength(4);
    const inSizes = calls.map(
      (c) => (c.filters.find((f) => f.op === 'in')!.value as string[]).length,
    );
    expect(inSizes).toEqual([30, 30, 30, 10]);
  });

  it('builds the per-chunk filter list as [axbType==…, sourceField in chunk] in forward direction', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
    });
    expect(calls[0].filters).toEqual([
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'aUid', op: 'in', value: ['u1'] },
    ]);
  });

  it('uses bUid as the source field in reverse direction', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    await runFirestoreClassicExpand(adapter, {
      sources: ['t1'],
      axbType: 'hasDeparture',
      direction: 'reverse',
    });
    const inFilter = calls[0].filters.find((f) => f.op === 'in');
    expect(inFilter!.field).toBe('bUid');
  });

  it('appends optional aType / bType filters after the source-field filter', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
      aType: 'tour',
      bType: 'departure',
    });
    expect(calls[0].filters).toEqual([
      { field: 'axbType', op: '==', value: 'hasDeparture' },
      { field: 'aUid', op: 'in', value: ['u1'] },
      { field: 'aType', op: '==', value: 'tour' },
      { field: 'bType', op: '==', value: 'departure' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Per-chunk options — orderBy + soft per-chunk limit
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — per-chunk options', () => {
  it('passes orderBy through to every chunk so Firestore can sort server-side', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    const sources = Array.from({ length: 60 }, (_, i) => `u${i}`);
    await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt', direction: 'desc' },
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.options?.orderBy).toEqual({ field: 'data.startsAt', direction: 'desc' });
    }
  });

  it('caps each chunk at chunk.length * limitPerSource as a soft per-chunk limit', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    const sources = Array.from({ length: 65 }, (_, i) => `u${i}`);
    await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
      limitPerSource: 4,
    });
    // 30, 30, 5 chunks → caps 120, 120, 20.
    expect(calls.map((c) => c.options?.limit)).toEqual([120, 120, 20]);
  });

  it('omits per-chunk limit when limitPerSource is undefined', async () => {
    const { adapter, calls } = makeAdapter(() => []);
    await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
    });
    expect(calls[0].options?.limit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Post-process — concat, cross-chunk re-sort, total-limit slice
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — post-process', () => {
  it('concatenates per-chunk results in chunk order when orderBy is unset', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [row('u1', 'd1'), row('u1', 'd2')],
      [row('u2', 'd3')],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const sources = Array.from({ length: 31 }, (_, i) => `u${i}`); // splits into 30+1
    const out = await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
    });
    expect(out.edges.map((e) => e.bUid)).toEqual(['d1', 'd2', 'd3']);
  });

  it('re-sorts ascending across chunks when orderBy.direction === "asc"', async () => {
    // Each per-chunk response is sorted, but the cross-chunk concat is
    // not. The helper re-sorts.
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [
        row('u1', 'd1', 'hasDeparture', { startsAt: 5 }),
        row('u1', 'd2', 'hasDeparture', { startsAt: 9 }),
      ],
      [row('u2', 'd3', 'hasDeparture', { startsAt: 1 })],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const sources = Array.from({ length: 31 }, (_, i) => `u${i}`);
    const out = await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt', direction: 'asc' },
    });
    expect(out.edges.map((e) => (e.data as { startsAt: number }).startsAt)).toEqual([1, 5, 9]);
  });

  it('re-sorts descending across chunks when orderBy.direction === "desc"', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [
        row('u1', 'd1', 'hasDeparture', { startsAt: 5 }),
        row('u1', 'd2', 'hasDeparture', { startsAt: 9 }),
      ],
      [row('u2', 'd3', 'hasDeparture', { startsAt: 1 })],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const sources = Array.from({ length: 31 }, (_, i) => `u${i}`);
    const out = await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt', direction: 'desc' },
    });
    expect(out.edges.map((e) => (e.data as { startsAt: number }).startsAt)).toEqual([9, 5, 1]);
  });

  it('defaults orderBy.direction to ascending when unspecified', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [
        row('u1', 'd1', 'hasDeparture', { startsAt: 5 }),
        row('u1', 'd2', 'hasDeparture', { startsAt: 9 }),
      ],
      [row('u2', 'd3', 'hasDeparture', { startsAt: 1 })],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const sources = Array.from({ length: 31 }, (_, i) => `u${i}`);
    const out = await runFirestoreClassicExpand(adapter, {
      sources,
      axbType: 'hasDeparture',
      orderBy: { field: 'data.startsAt' },
    });
    expect(out.edges.map((e) => (e.data as { startsAt: number }).startsAt)).toEqual([1, 5, 9]);
  });

  it('caps the total result at sources.length * limitPerSource after concat', async () => {
    // Force the slice path: make the (single, sub-cap) chunk return more
    // rows than `sources.length * limitPerSource`. The mock adapter
    // ignores the per-chunk soft limit we pass in `options.limit`, which
    // is exactly the case we want to pin — the post-concat slice is the
    // last line of defence regardless of whether the backend honours the
    // per-chunk hint.
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      // 6 rows from the single 4-source chunk; totalLimit is 4 → slice
      // drops the trailing two.
      [
        row('u1', 'd1'),
        row('u2', 'd2'),
        row('u3', 'd3'),
        row('u4', 'd4'),
        row('u1', 'd5'),
        row('u2', 'd6'),
      ],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1', 'u2', 'u3', 'u4'],
      axbType: 'hasDeparture',
      limitPerSource: 1,
    });
    expect(out.edges).toHaveLength(4); // sources.length * limitPerSource = 4
    expect(out.edges.map((e) => e.bUid)).toEqual(['d1', 'd2', 'd3', 'd4']);
  });

  it('skips the slice when total edge count is at or below the limit', async () => {
    // Sanity: when the result already fits inside `totalLimit`, no slice
    // happens and every edge survives.
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [[row('u1', 'd1'), row('u2', 'd2')]];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1', 'u2'],
      axbType: 'hasDeparture',
      limitPerSource: 5, // totalLimit = 10
    });
    expect(out.edges).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// NODE_RELATION self-loop guard
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — NODE_RELATION self-loop guard', () => {
  it('filters out edges where aUid === bUid when axbType === NODE_RELATION', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [
        row('u1', 'u1', 'is'), // self-loop — drop
        row('u1', 'u2', 'is'), // not a self-loop — keep
      ],
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'is',
    });
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ bUid: 'u2' });
  });

  it('does NOT filter self-loops when axbType is a regular edge type', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [[row('u1', 'u1', 'self-ref')]];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'self-ref',
    });
    expect(out.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

describe('runFirestoreClassicExpand — hydration', () => {
  it('issues a follow-up query per hydration chunk that filters axbType=is AND aUid in <chunk>', async () => {
    let callIndex = 0;
    // Two responses: the fan-out call and the hydration call.
    const responses: StoredGraphRecord[][] = [
      [row('u1', 'd1'), row('u1', 'd2')],
      [
        // Self-loops for the two targets.
        row('d1', 'd1', 'is'),
        row('d2', 'd2', 'is'),
      ],
    ];
    const { adapter, calls } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.edges).toHaveLength(2);
    expect(out.targets).toHaveLength(2);
    expect(out.targets![0]).toMatchObject({ bUid: 'd1' });
    expect(out.targets![1]).toMatchObject({ bUid: 'd2' });

    // Total adapter calls: 1 fan-out + 1 hydration chunk.
    expect(calls).toHaveLength(2);
    expect(calls[1].filters).toEqual([
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'aUid', op: 'in', value: ['d1', 'd2'] },
    ]);
  });

  it('returns null in the targets array for unresolved references', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [row('u1', 'd1')],
      [], // empty hydration → orphan reference
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.targets).toEqual([null]);
  });

  it('chunks the hydration query the same way as the fan-out (30-element cap)', async () => {
    // 65 unique target UIDs → 3 hydration chunks (30 + 30 + 5).
    let callIndex = 0;
    const fanout: StoredGraphRecord[] = Array.from({ length: 65 }, (_, i) => row('u1', `d${i}`));
    const hydrate1: StoredGraphRecord[] = Array.from({ length: 30 }, (_, i) =>
      row(`d${i}`, `d${i}`, 'is'),
    );
    const hydrate2: StoredGraphRecord[] = Array.from({ length: 30 }, (_, i) =>
      row(`d${i + 30}`, `d${i + 30}`, 'is'),
    );
    const hydrate3: StoredGraphRecord[] = Array.from({ length: 5 }, (_, i) =>
      row(`d${i + 60}`, `d${i + 60}`, 'is'),
    );
    const responses: StoredGraphRecord[][] = [fanout, hydrate1, hydrate2, hydrate3];
    const { adapter, calls } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    // 1 fan-out + 3 hydration chunks.
    expect(calls).toHaveLength(4);
    expect(out.targets).toHaveLength(65);
    expect(out.targets!.every((t) => t !== null)).toBe(true);
  });

  it('uses aUid as the hydration key for reverse direction', async () => {
    let callIndex = 0;
    const responses: StoredGraphRecord[][] = [
      [row('t1', 'd1')], // edge with aUid=t1
      [row('t1', 't1', 'is')], // self-loop for t1
    ];
    const { adapter } = makeAdapter(() => responses[callIndex++] ?? []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['d1'],
      axbType: 'hasDeparture',
      direction: 'reverse',
      hydrate: true,
    });
    expect(out.targets).toHaveLength(1);
    expect(out.targets![0]).toMatchObject({ bUid: 't1' });
  });

  it('returns { edges, targets: [] } when the fan-out yields zero rows', async () => {
    const { adapter } = makeAdapter(() => []);
    const out = await runFirestoreClassicExpand(adapter, {
      sources: ['u1'],
      axbType: 'hasDeparture',
      hydrate: true,
    });
    expect(out.edges).toEqual([]);
    expect(out.targets).toEqual([]);
  });
});
