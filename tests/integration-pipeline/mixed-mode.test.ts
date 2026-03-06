/**
 * Pipeline Integration — Mixed Mode Tests
 *
 * Validates that transactions always use standard queries even when the
 * client is in pipeline mode, and that both modes coexist correctly.
 * Full transaction CRUD coverage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  createStandardClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient } from '../../src/types.js';
import { tourData, departureData } from '../helpers/fixtures.js';

describe('pipeline mixed mode', () => {
  const collPath = uniqueCollectionPath();
  let pipeline: GraphClient;

  beforeAll(async () => {
    pipeline = createPipelineClient(collPath);

    await pipeline.putNode('tour', 'mx1', { name: 'Mixed Tour' });
    await pipeline.putNode('departure', 'mx2', { date: '2025-07' });
    await pipeline.putEdge('tour', 'mx1', 'hasDeparture', 'departure', 'mx2', { order: 0 });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  describe('transactions (always standard queries)', () => {
    it('read-then-write: data persists after transaction', async () => {
      await pipeline.putNode('departure', 'mx-dep1', { ...departureData, registeredRiders: 0 });

      await pipeline.runTransaction(async (tx) => {
        const dep = await tx.getNode('mx-dep1');
        await tx.updateNode('mx-dep1', {
          'data.registeredRiders': (dep!.data.registeredRiders as number) + 1,
        });
      });

      const updated = await pipeline.getNode('mx-dep1');
      expect(updated!.data.registeredRiders).toBe(1);
    });

    it('rollback on error: no writes persist', async () => {
      await pipeline.putNode('tour', 'mx-tour2', tourData);

      await expect(
        pipeline.runTransaction(async (tx) => {
          await tx.updateNode('mx-tour2', { 'data.name': 'Should Not Persist' });
          throw new Error('Intentional rollback');
        }),
      ).rejects.toThrow('Intentional rollback');

      const node = await pipeline.getNode('mx-tour2');
      expect(node!.data.name).toBe('Dolomites Classic');
    });

    it('conditional write: read, check, write', async () => {
      await pipeline.putNode('departure', 'mx-dep2', { ...departureData, maxCapacity: 2, registeredRiders: 1 });

      await pipeline.runTransaction(async (tx) => {
        const dep = await tx.getNode('mx-dep2');
        const registered = dep!.data.registeredRiders as number;
        const max = dep!.data.maxCapacity as number;
        if (registered < max) {
          await tx.updateNode('mx-dep2', { 'data.registeredRiders': registered + 1 });
        }
      });

      const dep = await pipeline.getNode('mx-dep2');
      expect(dep!.data.registeredRiders).toBe(2);
    });

    it('transaction supports putNode and putEdge', async () => {
      await pipeline.runTransaction(async (tx) => {
        await tx.putNode('tour', 'mx-tour3', tourData);
        await tx.putEdge('tour', 'mx-tour3', 'hasDeparture', 'departure', 'mx-dep3', { order: 0 });
      });

      const node = await pipeline.getNode('mx-tour3');
      const edge = await pipeline.getEdge('mx-tour3', 'hasDeparture', 'mx-dep3');
      expect(node).not.toBeNull();
      expect(edge).not.toBeNull();
    });

    it('transaction supports removeNode and removeEdge', async () => {
      await pipeline.putNode('tour', 'mx-tour4', tourData);
      await pipeline.putEdge('tour', 'mx-tour4', 'hasDeparture', 'departure', 'mx-dep4', { order: 0 });

      await pipeline.runTransaction(async (tx) => {
        await tx.removeEdge('mx-tour4', 'hasDeparture', 'mx-dep4');
        await tx.removeNode('mx-tour4');
      });

      expect(await pipeline.getNode('mx-tour4')).toBeNull();
      expect(await pipeline.getEdge('mx-tour4', 'hasDeparture', 'mx-dep4')).toBeNull();
    });

    it('transaction supports findEdges (standard queries)', async () => {
      await pipeline.putEdge('tour', 'mx1', 'hasDeparture', 'departure', 'mx-dep5', { order: 5 });

      const edges = await pipeline.runTransaction(async (tx) => {
        return tx.findEdges({ aUid: 'mx1', axbType: 'hasDeparture' });
      });

      expect(edges.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('mode parity', () => {
    it('pipeline and standard clients read same node data', async () => {
      const standard = createStandardClient(collPath);

      const [pipeNode, stdNode] = await Promise.all([
        pipeline.getNode('mx1'),
        standard.getNode('mx1'),
      ]);
      expect(pipeNode!.data).toEqual(stdNode!.data);
    });

    it('pipeline and standard clients return same edge counts', async () => {
      const standard = createStandardClient(collPath);

      const [pipeEdges, stdEdges] = await Promise.all([
        pipeline.findEdges({ axbType: 'hasDeparture' }),
        standard.findEdges({ axbType: 'hasDeparture' }),
      ]);
      expect(pipeEdges.length).toBe(stdEdges.length);
    });
  });

  describe('batch writes in pipeline mode', () => {
    it('batch creates multiple nodes atomically', async () => {
      const batch = pipeline.batch();
      await batch.putNode('rider', 'bx1', { name: 'Batch Rider 1' });
      await batch.putNode('rider', 'bx2', { name: 'Batch Rider 2' });
      await batch.commit();

      const [r1, r2] = await Promise.all([
        pipeline.getNode('bx1'),
        pipeline.getNode('bx2'),
      ]);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
    });

    it('batch mixed operations (put + edge + remove)', async () => {
      await pipeline.putEdge('tour', 'mx1', 'hasTag', 'tag', 'tag1', { label: 'scenic' });

      const batch = pipeline.batch();
      await batch.putNode('tag', 'tag2', { label: 'hard' });
      await batch.putEdge('tour', 'mx1', 'hasTag', 'tag', 'tag2', { label: 'hard' });
      await batch.removeEdge('mx1', 'hasTag', 'tag1');
      await batch.commit();

      expect(await pipeline.getEdge('mx1', 'hasTag', 'tag1')).toBeNull();
      expect(await pipeline.getEdge('mx1', 'hasTag', 'tag2')).not.toBeNull();
      expect(await pipeline.getNode('tag2')).not.toBeNull();
    });
  });
});
