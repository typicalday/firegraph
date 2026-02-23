import { describe, it, expect, beforeAll } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createTraversal } from '../../src/traverse.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

describe('traversal integration', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  // Graph fixture:
  // tour1 --hasDeparture--> dep1 --hasRider--> rider1 (confirmed)
  // tour1 --hasDeparture--> dep2 --hasRider--> rider2 (pending)
  // tour1 --hasDeparture--> dep3 --hasRider--> rider3 (confirmed)
  //                         dep1 --hasRider--> rider4 (confirmed)
  beforeAll(async () => {
    g = createGraphClient(db, uniqueCollectionPath());

    await g.putNode('tour', 'tour1', { name: 'Dolomites Classic' });
    await g.putNode('departure', 'dep1', { date: '2025-07-15' });
    await g.putNode('departure', 'dep2', { date: '2025-08-01' });
    await g.putNode('departure', 'dep3', { date: '2025-09-01' });
    await g.putNode('rider', 'rider1', { name: 'Alex' });
    await g.putNode('rider', 'rider2', { name: 'Maria' });
    await g.putNode('rider', 'rider3', { name: 'Chen' });
    await g.putNode('rider', 'rider4', { name: 'Luca' });

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', { order: 2 });
    await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider1', { status: 'confirmed' });
    await g.putEdge('departure', 'dep2', 'hasRider', 'rider', 'rider2', { status: 'pending' });
    await g.putEdge('departure', 'dep3', 'hasRider', 'rider', 'rider3', { status: 'confirmed' });
    await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider4', { status: 'confirmed' });
  });

  describe('single hop', () => {
    it('Tour → departures returns correct edges', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes.every((e) => e.axbType === 'hasDeparture')).toBe(true);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('two hops', () => {
    it('Tour → departures → riders returns riders', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run();

      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
      expect(result.nodes.every((e) => e.axbType === 'hasRider')).toBe(true);
      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].axbType).toBe('hasDeparture');
      expect(result.hops[1].axbType).toBe('hasRider');
    });
  });

  describe('reverse traversal', () => {
    it('Rider → (reverse hasRider) → departures', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aUid).toBe('dep1');
      expect(result.nodes[0].bUid).toBe('rider1');
    });

    it('two-hop reverse: Rider → departures → tours', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse' })
        .follow('hasDeparture', { direction: 'reverse' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aUid).toBe('tour1');
    });
  });

  describe('per-hop limit', () => {
    it('limit=2 on first hop returns max 2 departures', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { limit: 2 })
        .run();

      expect(result.nodes).toHaveLength(2);
    });
  });

  describe('in-memory filter', () => {
    it('filter callback excludes certain edges', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider', {
          filter: (e) => e.data.status === 'confirmed',
        })
        .run();

      expect(result.nodes.every((e) => e.data.status === 'confirmed')).toBe(true);
      expect(result.nodes.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('budget enforcement', () => {
    it('maxReads=2 with fan-out sets truncated=true', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ maxReads: 2 });

      expect(result.totalReads).toBeLessThanOrEqual(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe('return intermediates', () => {
    it('result.hops has per-hop edge arrays', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ returnIntermediates: true });

      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].edges.length).toBeGreaterThan(0);
      expect(result.hops[0].edges.every((e) => e.axbType === 'hasDeparture')).toBe(true);
      expect(result.hops[1].edges.length).toBeGreaterThan(0);
      expect(result.hops[1].edges.every((e) => e.axbType === 'hasRider')).toBe(true);
    });
  });

  describe('empty results', () => {
    it('traversal from nonexistent node returns empty', async () => {
      const result = await createTraversal(g, 'nonexistent-uid')
        .follow('hasDeparture')
        .run();

      expect(result.nodes).toHaveLength(0);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('transaction support', () => {
    it('works inside runTransaction', async () => {
      const result = await g.runTransaction(async (tx) => {
        return createTraversal(tx, 'tour1')
          .follow('hasDeparture')
          .follow('hasRider')
          .run();
      });

      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
      expect(result.hops).toHaveLength(2);
    });
  });

  describe('limit/orderBy on findEdges', () => {
    it('findEdges gains limit support', async () => {
      const edges = await g.findEdges({ aUid: 'tour1', axbType: 'hasDeparture', limit: 1 });
      expect(edges).toHaveLength(1);
      expect(edges[0].axbType).toBe('hasDeparture');
    });
  });
});
