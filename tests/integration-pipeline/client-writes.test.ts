/**
 * Pipeline Integration — Client Write Tests
 *
 * Validates that all write operations work correctly when the client is
 * in pipeline mode. Writes use the standard adapter (not pipeline), but
 * we verify the full write → read round-trip through a pipeline client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { GraphClient } from '../../src/types.js';
import { tourData } from '../helpers/fixtures.js';
import { cleanupCollection, createPipelineClient, uniqueCollectionPath } from './setup.js';

describe('pipeline client writes', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(() => {
    g = createPipelineClient(collPath);
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  describe('putNode', () => {
    it('creates a node retrievable by getNode', async () => {
      await g.putNode('tour', 'w-tour1', tourData);
      const node = await g.getNode('w-tour1');
      expect(node).not.toBeNull();
      expect(node!.aType).toBe('tour');
      expect(node!.bType).toBe('tour');
      expect(node!.aUid).toBe('w-tour1');
      expect(node!.bUid).toBe('w-tour1');
      expect(node!.axbType).toBe('is');
      expect(node!.data).toEqual(tourData);
    });

    it('overwrites when writing same node twice (idempotent)', async () => {
      await g.putNode('tour', 'w-tour2', { name: 'Original' });
      await g.putNode('tour', 'w-tour2', { name: 'Updated' });
      const node = await g.getNode('w-tour2');
      expect(node!.data).toEqual({ name: 'Updated' });
    });
  });

  describe('putEdge', () => {
    it('creates an edge retrievable by getEdge', async () => {
      await g.putEdge('tour', 'w-tour1', 'hasDeparture', 'departure', 'w-dep1', { order: 0 });
      const edge = await g.getEdge('w-tour1', 'hasDeparture', 'w-dep1');
      expect(edge).not.toBeNull();
      expect(edge!.aType).toBe('tour');
      expect(edge!.bType).toBe('departure');
      expect(edge!.aUid).toBe('w-tour1');
      expect(edge!.bUid).toBe('w-dep1');
      expect(edge!.axbType).toBe('hasDeparture');
      expect(edge!.data).toEqual({ order: 0 });
    });

    it('overwrites same edge twice (idempotent)', async () => {
      await g.putEdge('tour', 'w-tour1', 'hasDeparture', 'departure', 'w-dep2', { order: 0 });
      await g.putEdge('tour', 'w-tour1', 'hasDeparture', 'departure', 'w-dep2', { order: 1 });
      const edge = await g.getEdge('w-tour1', 'hasDeparture', 'w-dep2');
      expect(edge!.data).toEqual({ order: 1 });
    });
  });

  describe('updateNode', () => {
    it('partially updates fields within the data map', async () => {
      await g.putNode('tour', 'w-tour3', tourData);
      await g.updateNode('w-tour3', { name: 'New Name' });
      const node = await g.getNode('w-tour3');
      expect(node!.data.name).toBe('New Name');
      expect(node!.data.difficulty).toBe('hard');
    });

    it('throws on update of nonexistent doc', async () => {
      await expect(g.updateNode('nonexistent-w', { name: 'X' })).rejects.toThrow();
    });
  });

  describe('removeNode', () => {
    it('removes a node so it no longer exists', async () => {
      await g.putNode('tour', 'w-tour4', tourData);
      await g.removeNode('w-tour4');
      const node = await g.getNode('w-tour4');
      expect(node).toBeNull();
    });
  });

  describe('removeEdge', () => {
    it('removes an edge so it no longer exists', async () => {
      await g.putEdge('tour', 'w-tour1', 'hasDeparture', 'departure', 'w-dep3', {});
      await g.removeEdge('w-tour1', 'hasDeparture', 'w-dep3');
      const edge = await g.getEdge('w-tour1', 'hasDeparture', 'w-dep3');
      expect(edge).toBeNull();
    });
  });

  describe('write → pipeline query round-trip', () => {
    it('written nodes are findable via pipeline query', async () => {
      await g.putNode('vehicle', 'v1', { type: 'van' });
      await g.putNode('vehicle', 'v2', { type: 'bus' });

      const results = await g.findNodes({ aType: 'vehicle' });
      expect(results.length).toBe(2);
      const types = results.map((r) => r.data.type).sort();
      expect(types).toEqual(['bus', 'van']);
    });

    it('written edges are findable via pipeline query', async () => {
      await g.putEdge('vehicle', 'v1', 'assignedTo', 'tour', 'w-tour1', { role: 'support' });
      await g.putEdge('vehicle', 'v2', 'assignedTo', 'tour', 'w-tour1', { role: 'main' });

      const results = await g.findEdges({ axbType: 'assignedTo', bUid: 'w-tour1' });
      expect(results.length).toBe(2);
    });

    it('updated data is reflected in pipeline query results', async () => {
      await g.putNode('tour', 'w-tour3', { name: 'New Name', difficulty: 'hard', maxRiders: 30 });
      await g.updateNode('w-tour3', { difficulty: 'extreme' });

      const results = await g.findEdges({
        axbType: 'is',
        aType: 'tour',
        where: [{ field: 'difficulty', op: '==', value: 'extreme' }],
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.aUid === 'w-tour3')).toBe(true);
    });
  });
});
