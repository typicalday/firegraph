/**
 * Pipeline Integration — Client Read Tests
 *
 * Validates that createGraphClient with queryMode: 'pipeline' produces
 * identical results to standard mode for basic read operations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  createStandardClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient } from '../../src/types.js';

describe('pipeline client reads', () => {
  const collPath = uniqueCollectionPath();
  let pipeline: GraphClient;
  let standard: GraphClient;

  beforeAll(async () => {
    pipeline = createPipelineClient(collPath);
    standard = createStandardClient(collPath);

    // Seed data via standard client (writes don't use pipelines)
    await pipeline.putNode('tour', 'tour1', { name: 'Dolomites Classic', difficulty: 'hard', price: 5000 });
    await pipeline.putNode('tour', 'tour2', { name: 'Alps Easy', difficulty: 'easy', price: 2000 });
    await pipeline.putNode('tour', 'tour3', { name: 'Colorado Trail', difficulty: 'medium', price: 3500 });
    await pipeline.putNode('departure', 'dep1', { date: '2025-07-15', spotsLeft: 5 });
    await pipeline.putNode('departure', 'dep2', { date: '2025-08-01', spotsLeft: 0 });

    await pipeline.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0, guide: 'Marco' });
    await pipeline.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1, guide: 'Luca' });
    await pipeline.putEdge('tour', 'tour2', 'hasDeparture', 'departure', 'dep1', { order: 0, guide: 'Marco' });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  // -----------------------------------------------------------------------
  // GET strategy (doc lookups) — same on both modes
  // -----------------------------------------------------------------------
  describe('direct lookups (GET strategy)', () => {
    it('getNode returns the same result', async () => {
      const [pipeResult, stdResult] = await Promise.all([
        pipeline.getNode('tour1'),
        standard.getNode('tour1'),
      ]);
      expect(pipeResult).not.toBeNull();
      expect(pipeResult!.data.name).toBe('Dolomites Classic');
      expect(pipeResult!.aUid).toBe(stdResult!.aUid);
      expect(pipeResult!.data).toEqual(stdResult!.data);
    });

    it('getEdge returns the same result', async () => {
      const [pipeResult, stdResult] = await Promise.all([
        pipeline.getEdge('tour1', 'hasDeparture', 'dep1'),
        standard.getEdge('tour1', 'hasDeparture', 'dep1'),
      ]);
      expect(pipeResult).not.toBeNull();
      expect(pipeResult!.data.guide).toBe('Marco');
      expect(pipeResult!.data).toEqual(stdResult!.data);
    });

    it('edgeExists works on both modes', async () => {
      const [pipeExists, stdExists] = await Promise.all([
        pipeline.edgeExists('tour1', 'hasDeparture', 'dep1'),
        standard.edgeExists('tour1', 'hasDeparture', 'dep1'),
      ]);
      expect(pipeExists).toBe(true);
      expect(stdExists).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // QUERY strategy — pipeline adapter used here
  // -----------------------------------------------------------------------
  describe('query-based reads (QUERY strategy)', () => {
    it('findNodes returns same results via pipeline', async () => {
      const results = await pipeline.findNodes({ aType: 'tour' });
      expect(results.length).toBe(3);
      const names = results.map(r => r.data.name).sort();
      expect(names).toEqual(['Alps Easy', 'Colorado Trail', 'Dolomites Classic']);
    });

    it('findEdges by axbType returns same results', async () => {
      const [pipeResults, stdResults] = await Promise.all([
        pipeline.findEdges({ axbType: 'hasDeparture' }),
        standard.findEdges({ axbType: 'hasDeparture' }),
      ]);
      expect(pipeResults.length).toBe(3);
      expect(pipeResults.length).toBe(stdResults.length);

      // Same edge UIDs
      const pipeUids = pipeResults.map(r => `${r.aUid}->${r.bUid}`).sort();
      const stdUids = stdResults.map(r => `${r.aUid}->${r.bUid}`).sort();
      expect(pipeUids).toEqual(stdUids);
    });

    it('findEdges with aUid filter works via pipeline', async () => {
      const results = await pipeline.findEdges({
        aUid: 'tour1',
        axbType: 'hasDeparture',
      });
      expect(results.length).toBe(2);
    });

    it('findEdges with orderBy works via pipeline', async () => {
      const results = await pipeline.findEdges({
        aUid: 'tour1',
        axbType: 'hasDeparture',
        orderBy: { field: 'data.order', direction: 'asc' },
      });
      expect(results.length).toBe(2);
      expect(results[0].data.order).toBe(0);
      expect(results[1].data.order).toBe(1);
    });

    it('findEdges with limit works via pipeline', async () => {
      const results = await pipeline.findEdges({
        axbType: 'hasDeparture',
        limit: 2,
      });
      expect(results.length).toBe(2);
    });

    it('findEdges reverse lookup (axbType + bUid)', async () => {
      const results = await pipeline.findEdges({
        axbType: 'hasDeparture',
        bUid: 'dep1',
      });
      expect(results.length).toBe(2); // tour1->dep1 and tour2->dep1
      for (const r of results) {
        expect(r.bUid).toBe('dep1');
      }
    });

    it('findEdges type-scoped forward (aType + axbType)', async () => {
      const results = await pipeline.findEdges({
        aType: 'tour',
        axbType: 'hasDeparture',
      });
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.aType).toBe('tour');
      }
    });

    it('findEdges type-scoped reverse (axbType + bType)', async () => {
      const results = await pipeline.findEdges({
        axbType: 'hasDeparture',
        bType: 'departure',
      });
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.bType).toBe('departure');
      }
    });

    it('getNode returns null for nonexistent node', async () => {
      const result = await pipeline.getNode('nonexistent-read');
      expect(result).toBeNull();
    });

    it('getEdge returns null for nonexistent edge', async () => {
      const result = await pipeline.getEdge('nonexistent', 'hasDeparture', 'also-nonexistent');
      expect(result).toBeNull();
    });

    it('edgeExists returns false for nonexistent edge', async () => {
      const result = await pipeline.edgeExists('nonexistent', 'hasDeparture', 'also-nonexistent');
      expect(result).toBe(false);
    });

    it('findEdges returns empty for no matches', async () => {
      const results = await pipeline.findEdges({
        aUid: 'nonexistent',
        axbType: 'hasDeparture',
      });
      expect(results.length).toBe(0);
    });

    it('findNodes returns empty for nonexistent type', async () => {
      const results = await pipeline.findNodes({ aType: 'nonexistent-type' });
      expect(results.length).toBe(0);
    });

    it('findEdges smart optimization (aUid + axbType + bUid) uses GET', async () => {
      // When all 3 identifiers are provided, it should do a direct doc lookup
      const result = await pipeline.findEdges({
        aUid: 'tour1',
        axbType: 'hasDeparture',
        bUid: 'dep1',
      });
      expect(result.length).toBe(1);
      expect(result[0].aUid).toBe('tour1');
      expect(result[0].bUid).toBe('dep1');
    });
  });
});
