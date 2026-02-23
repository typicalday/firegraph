import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';
import { tourData, departureData } from '../helpers/fixtures.js';

describe('client writes', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath());
  });

  describe('putNode', () => {
    it('creates a node retrievable by getNode', async () => {
      await g.putNode('tour', 'tour1', tourData);
      const node = await g.getNode('tour1');
      expect(node).not.toBeNull();
      expect(node!.aType).toBe('tour');
      expect(node!.bType).toBe('tour');
      expect(node!.aUid).toBe('tour1');
      expect(node!.bUid).toBe('tour1');
      expect(node!.axbType).toBe('is');
      expect(node!.data).toEqual(tourData);
    });

    it('overwrites when writing same node twice (idempotent)', async () => {
      await g.putNode('tour', 'tour1', { name: 'Original' });
      await g.putNode('tour', 'tour1', { name: 'Updated' });
      const node = await g.getNode('tour1');
      expect(node!.data).toEqual({ name: 'Updated' });
    });
  });

  describe('putEdge', () => {
    it('creates an edge retrievable by getEdge', async () => {
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
      expect(edge).not.toBeNull();
      expect(edge!.aType).toBe('tour');
      expect(edge!.bType).toBe('departure');
      expect(edge!.aUid).toBe('tour1');
      expect(edge!.bUid).toBe('dep1');
      expect(edge!.axbType).toBe('hasDeparture');
      expect(edge!.data).toEqual({ order: 0 });
    });

    it('overwrites same edge twice (idempotent, same docId)', async () => {
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 1 });
      const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
      expect(edge!.data).toEqual({ order: 1 });
    });
  });

  describe('updateNode', () => {
    it('partially updates via dot notation', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.updateNode('tour1', { 'data.name': 'New Name' });
      const node = await g.getNode('tour1');
      expect(node!.data.name).toBe('New Name');
      expect(node!.data.difficulty).toBe('hard');
    });

    it('throws on update of nonexistent doc', async () => {
      await expect(g.updateNode('nonexistent', { 'data.name': 'X' })).rejects.toThrow();
    });
  });

  describe('removeNode', () => {
    it('removes a node so it no longer exists', async () => {
      await g.putNode('tour', 'tour1', tourData);
      await g.removeNode('tour1');
      const node = await g.getNode('tour1');
      expect(node).toBeNull();
    });
  });

  describe('removeEdge', () => {
    it('removes an edge so it no longer exists', async () => {
      await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', {});
      await g.removeEdge('tour1', 'hasDeparture', 'dep1');
      const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
      expect(edge).toBeNull();
    });
  });
});
