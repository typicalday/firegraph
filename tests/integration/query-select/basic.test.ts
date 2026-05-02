/**
 * Integration tests for `client.findEdgesProjected()` — Phase 7,
 * capability `query.select`.
 *
 * Runs against all backends that declare `query.select` (currently the SQLite
 * backend via `BACKEND=sqlite`, and Firestore via the default emulator setup).
 * The DO backend has its own dedicated suite (`tests/integration/cloudflare-*`)
 * because it needs Miniflare to stand up; the contract these tests pin is
 * shared.
 *
 * What this file pins:
 *
 *   - bare-name normalisation: `'name'` → `data.name` so most callers don't
 *     have to know about the envelope shape.
 *   - explicit `'data.x.y'` dotted paths return the same value `findEdges`
 *     would have surfaced.
 *   - top-level envelope fields (`aType`, `aUid`, `axbType`, `bType`,
 *     `bUid`) round-trip as their identifier strings, exactly as
 *     `findEdges` produces.
 *   - duplicate entries in `select` are de-duped (first-occurrence order
 *     preserved); the row carries one slot per unique path.
 *   - GET-shape projection (all three identifying UIDs) returns a
 *     single-row array — the client synthesises equality filters so the
 *     backend's projecting query hits the same row a `findEdges` GET
 *     would have hit.
 *   - empty `select: []` is rejected with INVALID_QUERY.
 *
 * What this file deliberately does NOT pin:
 *
 *   - migration bypass — covered in the unit suite
 *     (`tests/unit/client-find-edges-projected.test.ts`). Integration tests
 *     don't need to repeat it because the read pipeline already routes
 *     `findEdgesProjected` past `applyMigrations` at the client layer.
 *   - DO RPC encoding — covered in `cloudflare-sql.test.ts` and
 *     `cloudflare-rpc.test.ts`.
 *   - byte-savings on the wire — that's the *point* of the API but it's
 *     measured at the per-backend SQL/Firestore level, not at the client
 *     contract level.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { GraphClient } from '../../../src/types.js';
import { departureData, tourData } from '../../helpers/fixtures.js';
import { createTestGraphClient, ensureSqliteBackend, uniqueCollectionPath } from '../setup.js';

describe('findEdgesProjected — basic projection contract', () => {
  let g: GraphClient;

  beforeAll(async () => {
    await ensureSqliteBackend();
    g = createTestGraphClient(uniqueCollectionPath());

    // Seed a small graph: one tour, three departures with distinct dates,
    // one bookingFor edge with a nested data.detail object so we can pin
    // dotted-path projection too.
    await g.putNode('tour', 'tour1', tourData);
    await g.putNode('departure', 'dep1', { ...departureData, date: '2025-07-15' });
    await g.putNode('departure', 'dep2', { ...departureData, date: '2025-08-20' });
    await g.putNode('departure', 'dep3', { ...departureData, date: '2025-09-10' });

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', {
      order: 0,
      detail: { region: 'alps', priority: 'high' },
    });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', {
      order: 1,
      detail: { region: 'alps', priority: 'mid' },
    });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', {
      order: 2,
      detail: { region: 'pyrenees', priority: 'low' },
    });
  });

  it('rewrites bare names as data.<name>', async () => {
    // Bare-name normalisation is the most common shape — most callers
    // project a few keys out of the JSON payload.
    const rows = await g.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour1',
      axbType: 'hasDeparture',
      select: ['order'] as const,
    });

    // The query plan filters by aType/aUid/axbType; ordering is unspecified
    // so we sort by `order` for a stable assertion.
    const sorted = [...rows].sort((a, b) => (a.order as number) - (b.order as number));
    expect(sorted).toEqual([{ order: 0 }, { order: 1 }, { order: 2 }]);
  });

  it('returns top-level envelope fields verbatim', async () => {
    // Built-in envelope fields (`aType`, `aUid`, `axbType`, `bType`,
    // `bUid`) come back as their identifier strings, matching what
    // `findEdges()` surfaces.
    const rows = await g.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour1',
      axbType: 'hasDeparture',
      select: ['aType', 'aUid', 'axbType', 'bType', 'bUid'] as const,
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.aType).toBe('tour');
      expect(row.aUid).toBe('tour1');
      expect(row.axbType).toBe('hasDeparture');
      expect(row.bType).toBe('departure');
      expect(typeof row.bUid).toBe('string');
    }
  });

  it('resolves explicit dotted data paths', async () => {
    // `data.detail.region` is the explicit form for nested fields. Same
    // value `findEdges` would have produced.
    const rows = await g.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour1',
      axbType: 'hasDeparture',
      select: ['data.detail.region', 'order'] as const,
    });

    const sorted = [...rows].sort((a, b) => (a.order as number) - (b.order as number));
    expect(sorted.map((r) => r['data.detail.region'])).toEqual(['alps', 'alps', 'pyrenees']);
  });

  it('de-duplicates repeated entries in select', async () => {
    // `['order', 'order', 'order']` collapses to a single `order` slot.
    // The row carries one slot per unique field — not three.
    const rows = await g.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour1',
      axbType: 'hasDeparture',
      select: ['order', 'order', 'order'] as const,
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // Only one key in the projected row.
      expect(Object.keys(row)).toEqual(['order']);
      expect(typeof row.order).toBe('number');
    }
  });

  it('GET-shape (all three identifying UIDs) returns a single-row projection', async () => {
    // `buildEdgeQueryPlan` returns `{strategy: 'get', docId}` here — the
    // client synthesises equality filters so the backend's projecting
    // query hits the same row a `findEdges` GET would have hit.
    const rows = await g.findEdgesProjected({
      aType: 'tour',
      aUid: 'tour1',
      axbType: 'hasDeparture',
      bType: 'departure',
      bUid: 'dep2',
      select: ['order', 'data.detail.priority'] as const,
    });

    expect(rows).toEqual([{ order: 1, 'data.detail.priority': 'mid' }]);
  });

  it('rejects an empty select list with INVALID_QUERY', async () => {
    // `SELECT FROM …` (no projection clause) is syntactically distinct
    // from `SELECT * FROM …`; the latter is what `findEdges` already
    // does. Failing fast at the client surface gives a uniform error
    // across SQLite/DO/Firestore.
    await expect(
      g.findEdgesProjected({
        aType: 'tour',
        aUid: 'tour1',
        axbType: 'hasDeparture',
        select: [] as const,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    });
  });
});
