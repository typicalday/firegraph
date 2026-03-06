/**
 * Pipeline Integration — Traversal Tests
 *
 * Validates that multi-hop traversal works correctly when the underlying
 * client uses pipeline mode for queries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import { createTraversal } from '../../src/traverse.js';
import type { GraphClient } from '../../src/types.js';

describe('pipeline traversal', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(async () => {
    g = createPipelineClient(collPath);

    // Build graph: tour -> departure -> rider
    await g.putNode('tour', 'tour1', { name: 'Dolomites' });
    await g.putNode('departure', 'dep1', { date: '2025-07' });
    await g.putNode('departure', 'dep2', { date: '2025-08' });
    await g.putNode('rider', 'r1', { name: 'Jamie' });
    await g.putNode('rider', 'r2', { name: 'Jordan' });
    await g.putNode('rider', 'r3', { name: 'Casey' });

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', {});
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', {});
    await g.putEdge('rider', 'r1', 'bookedFor', 'departure', 'dep1', {});
    await g.putEdge('rider', 'r2', 'bookedFor', 'departure', 'dep1', {});
    await g.putEdge('rider', 'r3', 'bookedFor', 'departure', 'dep2', {});
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('single-hop forward traversal via pipeline', async () => {
    const result = await createTraversal(g, 'tour1')
      .follow('hasDeparture')
      .run();

    expect(result.nodes.length).toBe(2); // dep1 + dep2
    expect(result.hops.length).toBe(1);
    expect(result.hops[0].edges.length).toBe(2);
  });

  it('two-hop traversal: tour -> departures -> riders', async () => {
    const result = await createTraversal(g, 'tour1')
      .follow('hasDeparture')
      .follow('bookedFor', { direction: 'reverse' })
      .run();

    expect(result.hops.length).toBe(2);
    // Hop 1: tour1 -> dep1, dep2
    expect(result.hops[0].edges.length).toBe(2);
    // Hop 2: riders who booked dep1 or dep2
    expect(result.hops[1].edges.length).toBe(3);

    const riderUids = result.nodes.map(n => n.aUid).sort();
    expect(riderUids).toEqual(['r1', 'r2', 'r3']);
  });

  it('traversal with limit per hop', async () => {
    const result = await createTraversal(g, 'tour1')
      .follow('hasDeparture', { limit: 1 })
      .run();

    expect(result.hops[0].edges.length).toBe(1);
    expect(result.nodes.length).toBe(1);
  });
});
