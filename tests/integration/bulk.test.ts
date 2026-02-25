import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';
import { tourData, departureData, riderData } from '../helpers/fixtures.js';
import type { BulkProgress } from '../../src/types.js';

describe('bulk operations', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath());
  });

  describe('removeNodeCascade', () => {
    it('deletes a node with no edges', async () => {
      await g.putNode('tour', 'tour1', tourData);

      const result = await g.removeNodeCascade('tour1');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.errors).toEqual([]);

      const node = await g.getNode('tour1');
      expect(node).toBeNull();
    });

    it('deletes a node and all its outgoing edges', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.putNode('departure', 'dep1', departureData);
      await g.putNode('departure', 'dep2', departureData);
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });

      const result = await g.removeNodeCascade('tour1');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(2);
      expect(result.errors).toEqual([]);

      // Node gone
      expect(await g.getNode('tour1')).toBeNull();
      // Edges gone
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep1')).toBeNull();
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep2')).toBeNull();
      // Target nodes untouched
      expect(await g.getNode('dep1')).not.toBeNull();
      expect(await g.getNode('dep2')).not.toBeNull();
    });

    it('deletes incoming edges too', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.putNode('departure', 'dep1', departureData);
      await g.putNode('rider', 'r1', riderData);
      // tour1 -> dep1 (outgoing from tour1)
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      // r1 -> tour1 (incoming to tour1)
      await g.putEdge('rider', 'r1', 'bookedFor', 'tour', 'tour1', { confirmedAt: '2025-01-01' });

      const result = await g.removeNodeCascade('tour1');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(2);
      expect(result.errors).toEqual([]);

      // Both edges gone
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep1')).toBeNull();
      expect(await g.getEdge('r1', 'bookedFor', 'tour1')).toBeNull();
      // Other nodes untouched
      expect(await g.getNode('dep1')).not.toBeNull();
      expect(await g.getNode('r1')).not.toBeNull();
    });

    it('handles nonexistent node gracefully', async () => {
      const result = await g.removeNodeCascade('nonexistent');

      // Still tries to delete the node doc (Firestore delete is idempotent)
      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('calls onProgress callback', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });

      const progressCalls: BulkProgress[] = [];

      await g.removeNodeCascade('tour1', {
        onProgress: (p) => progressCalls.push({ ...p }),
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      const last = progressCalls[progressCalls.length - 1];
      expect(last.completedBatches).toBe(last.totalBatches);
    });
  });

  describe('bulkRemoveEdges', () => {
    it('deletes all edges matching a query', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', { order: 2 });

      const result = await g.bulkRemoveEdges({ aUid: 'tour1', axbType: 'hasDeparture' });

      expect(result.deleted).toBe(3);
      expect(result.errors).toEqual([]);

      // All edges gone
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep1')).toBeNull();
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep2')).toBeNull();
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep3')).toBeNull();

      // Node untouched
      expect(await g.getNode('tour1')).not.toBeNull();
    });

    it('returns zero for no matching edges', async () => {
      const result = await g.bulkRemoveEdges({ aUid: 'nonexistent', axbType: 'hasDeparture' });

      expect(result.deleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('respects batchSize option for chunking', async () => {
      // Create 5 edges
      for (let i = 0; i < 5; i++) {
        await g.putEdge('tour', 'tour1', 'hasItem', 'item', `item${i}`, { order: i });
      }

      const progressCalls: BulkProgress[] = [];

      const result = await g.bulkRemoveEdges(
        { aUid: 'tour1', axbType: 'hasItem' },
        {
          batchSize: 2,
          onProgress: (p) => progressCalls.push({ ...p }),
        },
      );

      expect(result.deleted).toBe(5);
      // 5 items in batches of 2 = 3 batches (2 + 2 + 1)
      expect(result.batches).toBe(3);
      expect(progressCalls.length).toBe(3);

      // Verify all edges are gone
      for (let i = 0; i < 5; i++) {
        expect(await g.getEdge('tour1', 'hasItem', `item${i}`)).toBeNull();
      }
    });

    it('only deletes edges matching the filter, not all edges', async () => {
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      await g.putEdge('tour', 'tour1', 'hasRider', 'rider', 'r1', { order: 0 });

      await g.bulkRemoveEdges({ aUid: 'tour1', axbType: 'hasDeparture' });

      // hasDeparture edge gone
      expect(await g.getEdge('tour1', 'hasDeparture', 'dep1')).toBeNull();
      // hasRider edge still there
      expect(await g.getEdge('tour1', 'hasRider', 'r1')).not.toBeNull();
    });
  });
});
