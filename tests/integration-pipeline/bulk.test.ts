/**
 * Pipeline Integration — Bulk Operation Tests
 *
 * Validates removeNodeCascade and bulkRemoveEdges in pipeline mode.
 * These operations use findEdges internally (which goes through the
 * pipeline adapter), so they're critical to test end-to-end.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  createPipelineClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient, BulkProgress } from '../../src/types.js';
import { tourData, departureData, riderData } from '../helpers/fixtures.js';

describe('pipeline bulk operations', () => {
  const collPaths: string[] = [];
  let collPath: string;
  let g: GraphClient;

  beforeEach(() => {
    collPath = uniqueCollectionPath();
    collPaths.push(collPath);
    g = createPipelineClient(collPath);
  });

  afterAll(async () => {
    for (const p of collPaths) {
      await cleanupCollection(p);
    }
  }, 30_000);

  describe('removeNodeCascade', () => {
    it('deletes a node with no edges', async () => {
      await g.putNode('tour', 'bc-tour1', tourData);

      const result = await g.removeNodeCascade('bc-tour1');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.errors).toEqual([]);
      expect(await g.getNode('bc-tour1')).toBeNull();
    }, 15_000);

    it('deletes a node and all its outgoing edges', async () => {
      await g.putNode('tour', 'bc-tour2', tourData);
      await g.putNode('departure', 'bc-dep1', departureData);
      await g.putNode('departure', 'bc-dep2', departureData);
      await g.putEdge('tour', 'bc-tour2', 'hasDeparture', 'departure', 'bc-dep1', { order: 0 });
      await g.putEdge('tour', 'bc-tour2', 'hasDeparture', 'departure', 'bc-dep2', { order: 1 });

      const result = await g.removeNodeCascade('bc-tour2');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(2);
      expect(result.errors).toEqual([]);

      expect(await g.getNode('bc-tour2')).toBeNull();
      expect(await g.getEdge('bc-tour2', 'hasDeparture', 'bc-dep1')).toBeNull();
      expect(await g.getEdge('bc-tour2', 'hasDeparture', 'bc-dep2')).toBeNull();
      // Target nodes untouched
      expect(await g.getNode('bc-dep1')).not.toBeNull();
      expect(await g.getNode('bc-dep2')).not.toBeNull();
    });

    it('deletes incoming edges too', async () => {
      await g.putNode('tour', 'bc-tour3', tourData);
      await g.putNode('departure', 'bc-dep3', departureData);
      await g.putNode('rider', 'bc-r1', riderData);
      await g.putEdge('tour', 'bc-tour3', 'hasDeparture', 'departure', 'bc-dep3', { order: 0 });
      await g.putEdge('rider', 'bc-r1', 'bookedFor', 'tour', 'bc-tour3', { confirmedAt: '2025-01-01' });

      const result = await g.removeNodeCascade('bc-tour3');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(2);
      expect(result.errors).toEqual([]);

      expect(await g.getEdge('bc-tour3', 'hasDeparture', 'bc-dep3')).toBeNull();
      expect(await g.getEdge('bc-r1', 'bookedFor', 'bc-tour3')).toBeNull();
      expect(await g.getNode('bc-dep3')).not.toBeNull();
      expect(await g.getNode('bc-r1')).not.toBeNull();
    });

    it('handles nonexistent node gracefully', async () => {
      const result = await g.removeNodeCascade('nonexistent-bc');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(0);
      expect(result.deleted).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('calls onProgress callback', async () => {
      await g.putNode('tour', 'bc-tour4', tourData);
      await g.putEdge('tour', 'bc-tour4', 'hasDeparture', 'departure', 'bc-dep4', { order: 0 });

      const progressCalls: BulkProgress[] = [];

      await g.removeNodeCascade('bc-tour4', {
        onProgress: (p) => progressCalls.push({ ...p }),
      });

      expect(progressCalls.length).toBeGreaterThan(0);
      const last = progressCalls[progressCalls.length - 1];
      expect(last.completedBatches).toBe(last.totalBatches);
    });

    it('handles mixed edge types in cascade', async () => {
      await g.putNode('tour', 'bc-tour5', tourData);
      await g.putEdge('tour', 'bc-tour5', 'hasDeparture', 'departure', 'bc-dep5', { order: 0 });
      await g.putEdge('tour', 'bc-tour5', 'hasRider', 'rider', 'bc-r2', { seat: 1 });
      await g.putEdge('tour', 'bc-tour5', 'hasRider', 'rider', 'bc-r3', { seat: 2 });

      const result = await g.removeNodeCascade('bc-tour5');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(3);
      expect(result.errors).toEqual([]);

      expect(await g.getNode('bc-tour5')).toBeNull();
      expect(await g.getEdge('bc-tour5', 'hasDeparture', 'bc-dep5')).toBeNull();
      expect(await g.getEdge('bc-tour5', 'hasRider', 'bc-r2')).toBeNull();
      expect(await g.getEdge('bc-tour5', 'hasRider', 'bc-r3')).toBeNull();
    });

    it('deduplicates self-referencing edges', async () => {
      await g.putNode('task', 'bc-task1', { title: 'root' });
      await g.putEdge('task', 'bc-task1', 'dependsOn', 'task', 'bc-task1', { reason: 'self' });

      const result = await g.removeNodeCascade('bc-task1');

      expect(result.nodeDeleted).toBe(true);
      expect(result.edgesDeleted).toBe(1);
      expect(result.errors).toEqual([]);

      expect(await g.getNode('bc-task1')).toBeNull();
      expect(await g.getEdge('bc-task1', 'dependsOn', 'bc-task1')).toBeNull();
    });
  });

  describe('bulkRemoveEdges', () => {
    it('deletes all edges matching a query', async () => {
      await g.putNode('tour', 'be-tour1', tourData);
      await g.putEdge('tour', 'be-tour1', 'hasDeparture', 'departure', 'be-dep1', { order: 0 });
      await g.putEdge('tour', 'be-tour1', 'hasDeparture', 'departure', 'be-dep2', { order: 1 });
      await g.putEdge('tour', 'be-tour1', 'hasDeparture', 'departure', 'be-dep3', { order: 2 });

      const result = await g.bulkRemoveEdges({ aUid: 'be-tour1', axbType: 'hasDeparture' });

      expect(result.deleted).toBe(3);
      expect(result.errors).toEqual([]);

      expect(await g.getEdge('be-tour1', 'hasDeparture', 'be-dep1')).toBeNull();
      expect(await g.getEdge('be-tour1', 'hasDeparture', 'be-dep2')).toBeNull();
      expect(await g.getEdge('be-tour1', 'hasDeparture', 'be-dep3')).toBeNull();
      expect(await g.getNode('be-tour1')).not.toBeNull();
    });

    it('returns zero for no matching edges', async () => {
      const result = await g.bulkRemoveEdges({ aUid: 'nonexistent-be', axbType: 'hasDeparture' });

      expect(result.deleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(result.errors).toEqual([]);
    });

    it('respects batchSize option for chunking', async () => {
      for (let i = 0; i < 5; i++) {
        await g.putEdge('tour', 'be-tour2', 'hasItem', 'item', `be-item${i}`, { order: i });
      }

      const progressCalls: BulkProgress[] = [];

      const result = await g.bulkRemoveEdges(
        { aUid: 'be-tour2', axbType: 'hasItem' },
        {
          batchSize: 2,
          onProgress: (p) => progressCalls.push({ ...p }),
        },
      );

      expect(result.deleted).toBe(5);
      expect(result.batches).toBe(3); // 2 + 2 + 1
      expect(progressCalls.length).toBe(3);

      for (let i = 0; i < 5; i++) {
        expect(await g.getEdge('be-tour2', 'hasItem', `be-item${i}`)).toBeNull();
      }
    });

    it('only deletes edges matching the filter, not all edges', async () => {
      await g.putEdge('tour', 'be-tour3', 'hasDeparture', 'departure', 'be-dep4', { order: 0 });
      await g.putEdge('tour', 'be-tour3', 'hasRider', 'rider', 'be-r1', { order: 0 });

      await g.bulkRemoveEdges({ aUid: 'be-tour3', axbType: 'hasDeparture' });

      expect(await g.getEdge('be-tour3', 'hasDeparture', 'be-dep4')).toBeNull();
      expect(await g.getEdge('be-tour3', 'hasRider', 'be-r1')).not.toBeNull();
    });

    it('deletes incoming edges by bUid', async () => {
      await g.putNode('departure', 'be-dep5', departureData);
      await g.putEdge('tour', 'be-tour4', 'hasDeparture', 'departure', 'be-dep5', { order: 0 });
      await g.putEdge('tour', 'be-tour5', 'hasDeparture', 'departure', 'be-dep5', { order: 1 });
      await g.putEdge('tour', 'be-tour6', 'hasDeparture', 'departure', 'be-dep5', { order: 2 });

      const result = await g.bulkRemoveEdges({ bUid: 'be-dep5', axbType: 'hasDeparture' });

      expect(result.deleted).toBe(3);
      expect(result.errors).toEqual([]);

      expect(await g.getEdge('be-tour4', 'hasDeparture', 'be-dep5')).toBeNull();
      expect(await g.getEdge('be-tour5', 'hasDeparture', 'be-dep5')).toBeNull();
      expect(await g.getEdge('be-tour6', 'hasDeparture', 'be-dep5')).toBeNull();
      expect(await g.getNode('be-dep5')).not.toBeNull();
    });

    it('supports where clauses to filter edges by data fields (pipeline query)', async () => {
      await g.putEdge('tour', 'be-tour7', 'hasDeparture', 'departure', 'be-dep6', { order: 0, status: 'draft' });
      await g.putEdge('tour', 'be-tour7', 'hasDeparture', 'departure', 'be-dep7', { order: 1, status: 'published' });
      await g.putEdge('tour', 'be-tour7', 'hasDeparture', 'departure', 'be-dep8', { order: 2, status: 'draft' });

      const result = await g.bulkRemoveEdges({
        aUid: 'be-tour7',
        axbType: 'hasDeparture',
        where: [{ field: 'status', op: '==', value: 'draft' }],
      });

      expect(result.deleted).toBe(2);
      expect(result.errors).toEqual([]);

      expect(await g.getEdge('be-tour7', 'hasDeparture', 'be-dep6')).toBeNull();
      expect(await g.getEdge('be-tour7', 'hasDeparture', 'be-dep8')).toBeNull();
      expect(await g.getEdge('be-tour7', 'hasDeparture', 'be-dep7')).not.toBeNull();
    });

    it('where clause with no matches deletes nothing', async () => {
      await g.putEdge('tour', 'be-tour8', 'hasDeparture', 'departure', 'be-dep9', { order: 0, status: 'published' });

      const result = await g.bulkRemoveEdges({
        aUid: 'be-tour8',
        axbType: 'hasDeparture',
        where: [{ field: 'status', op: '==', value: 'archived' }],
      });

      expect(result.deleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(await g.getEdge('be-tour8', 'hasDeparture', 'be-dep9')).not.toBeNull();
    });
  });

  describe('batch removeEdge in pipeline mode', () => {
    it('deletes specific edges atomically via batch', async () => {
      await g.putEdge('tour', 'bb-tour1', 'hasDeparture', 'departure', 'bb-dep1', { order: 0 });
      await g.putEdge('tour', 'bb-tour1', 'hasDeparture', 'departure', 'bb-dep2', { order: 1 });
      await g.putEdge('tour', 'bb-tour1', 'hasDeparture', 'departure', 'bb-dep3', { order: 2 });

      const batch = g.batch();
      await batch.removeEdge('bb-tour1', 'hasDeparture', 'bb-dep1');
      await batch.removeEdge('bb-tour1', 'hasDeparture', 'bb-dep3');
      await batch.commit();

      expect(await g.getEdge('bb-tour1', 'hasDeparture', 'bb-dep1')).toBeNull();
      expect(await g.getEdge('bb-tour1', 'hasDeparture', 'bb-dep3')).toBeNull();
      const dep2 = await g.getEdge('bb-tour1', 'hasDeparture', 'bb-dep2');
      expect(dep2).not.toBeNull();
      expect(dep2!.data.order).toBe(1);
    });

    it('batch removeEdge with different edge types', async () => {
      await g.putEdge('tour', 'bb-tour2', 'hasDeparture', 'departure', 'bb-dep4', { order: 0 });
      await g.putEdge('tour', 'bb-tour2', 'hasRider', 'rider', 'bb-r1', { seat: 1 });
      await g.putEdge('rider', 'bb-r1', 'bookedFor', 'tour', 'bb-tour2', { confirmedAt: '2025-01-01' });

      const batch = g.batch();
      await batch.removeEdge('bb-tour2', 'hasDeparture', 'bb-dep4');
      await batch.removeEdge('bb-tour2', 'hasRider', 'bb-r1');
      await batch.removeEdge('bb-r1', 'bookedFor', 'bb-tour2');
      await batch.commit();

      expect(await g.getEdge('bb-tour2', 'hasDeparture', 'bb-dep4')).toBeNull();
      expect(await g.getEdge('bb-tour2', 'hasRider', 'bb-r1')).toBeNull();
      expect(await g.getEdge('bb-r1', 'bookedFor', 'bb-tour2')).toBeNull();
    });

    it('batch removeEdge is idempotent for nonexistent edges', async () => {
      const batch = g.batch();
      await batch.removeEdge('nope1', 'hasX', 'nope2');
      await batch.removeEdge('nope3', 'hasY', 'nope4');
      await batch.commit();
    });
  });
});
