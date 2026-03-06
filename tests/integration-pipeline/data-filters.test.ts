/**
 * Pipeline Integration — Data Filter Tests
 *
 * The critical test suite: validates that firegraph's pipeline mode enables
 * data.* field filters WITHOUT requiring composite indexes. This is the
 * primary value proposition of pipeline mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient } from '../../src/types.js';

describe('pipeline data filters (no composite index needed)', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(async () => {
    g = createPipelineClient(collPath);

    // Create test data
    await g.putNode('tour', 'tourA', { name: 'Dolomites Classic', difficulty: 'hard', price: 5000, region: 'europe' });
    await g.putNode('tour', 'tourB', { name: 'Alps Easy', difficulty: 'easy', price: 2000, region: 'europe' });
    await g.putNode('tour', 'tourC', { name: 'Colorado Trail', difficulty: 'medium', price: 3500, region: 'americas' });

    await g.putEdge('tour', 'tourA', 'hasDeparture', 'departure', 'dep1', { guide: 'Marco', season: 'summer' });
    await g.putEdge('tour', 'tourA', 'hasDeparture', 'departure', 'dep2', { guide: 'Luca', season: 'winter' });
    await g.putEdge('tour', 'tourB', 'hasDeparture', 'departure', 'dep1', { guide: 'Marco', season: 'summer' });

    await g.putEdge('rider', 'r1', 'bookedFor', 'departure', 'dep1', { price: 5000, paid: true });
    await g.putEdge('rider', 'r2', 'bookedFor', 'departure', 'dep1', { price: 4500, paid: true });
    await g.putEdge('rider', 'r3', 'bookedFor', 'departure', 'dep2', { price: 5000, paid: false });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('filters edges by axbType + data.guide (topology + data)', async () => {
    const results = await g.findEdges({
      axbType: 'hasDeparture',
      where: [{ field: 'guide', op: '==', value: 'Marco' }],
    });
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.data.guide).toBe('Marco');
    }
  });

  it('filters nodes by aType + multiple data conditions', async () => {
    const results = await g.findEdges({
      axbType: 'is',
      aType: 'tour',
      where: [
        { field: 'region', op: '==', value: 'europe' },
        { field: 'price', op: '>', value: 3000 },
      ],
    });
    expect(results.length).toBe(1);
    expect(results[0].data.name).toBe('Dolomites Classic');
  });

  it('filters edges by data range (inequality on data field)', async () => {
    const results = await g.findEdges({
      axbType: 'bookedFor',
      where: [
        { field: 'price', op: '>', value: 2000 },
        { field: 'paid', op: '==', value: true },
      ],
    });
    expect(results.length).toBe(2);
  });

  it('filters with != operator on data field', async () => {
    const results = await g.findEdges({
      axbType: 'hasDeparture',
      where: [{ field: 'guide', op: '!=', value: 'Marco' }],
    });
    expect(results.length).toBe(1);
    expect(results[0].data.guide).toBe('Luca');
  });

  it('combines aUid + axbType + data filter', async () => {
    const results = await g.findEdges({
      aUid: 'tourA',
      axbType: 'hasDeparture',
      where: [{ field: 'season', op: '==', value: 'summer' }],
    });
    expect(results.length).toBe(1);
    expect(results[0].data.guide).toBe('Marco');
  });

  it('returns empty for non-matching data filters', async () => {
    const results = await g.findEdges({
      axbType: 'hasDeparture',
      where: [{ field: 'guide', op: '==', value: 'Nonexistent' }],
    });
    expect(results.length).toBe(0);
  });
});
