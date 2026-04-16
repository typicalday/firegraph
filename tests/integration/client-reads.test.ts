import { beforeAll, describe, expect, it } from 'vitest';

import type { GraphClient } from '../../src/types.js';
import { departureData, riderData, tourData } from '../helpers/fixtures.js';
import { createTestGraphClient, ensureSqliteBackend, uniqueCollectionPath } from './setup.js';

describe('client reads', () => {
  let g: GraphClient;

  beforeAll(async () => {
    await ensureSqliteBackend();
    g = createTestGraphClient(uniqueCollectionPath());

    await g.putNode('tour', 'tour1', tourData);
    await g.putNode('tour', 'tour2', { name: 'Alps Challenge' });
    await g.putNode('departure', 'dep1', departureData);
    await g.putNode('rider', 'rider1', riderData);

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
    await g.putEdge('rider', 'rider1', 'bookedForDeparture', 'departure', 'dep1', {
      confirmedAt: '2025-01-10',
    });
    await g.putEdge('tour', 'tour2', 'hasDeparture', 'departure', 'dep1', { order: 0 });
  });

  describe('getNode', () => {
    it('returns full record for existing node', async () => {
      const node = await g.getNode('tour1');
      expect(node).not.toBeNull();
      expect(node!.aType).toBe('tour');
      expect(node!.data).toEqual(tourData);
    });

    it('returns null for nonexistent node', async () => {
      const node = await g.getNode('nonexistent');
      expect(node).toBeNull();
    });
  });

  describe('getEdge', () => {
    it('returns edge by composite key', async () => {
      const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
      expect(edge).not.toBeNull();
      expect(edge!.aUid).toBe('tour1');
      expect(edge!.axbType).toBe('hasDeparture');
      expect(edge!.bUid).toBe('dep1');
    });

    it('returns null for nonexistent edge', async () => {
      const edge = await g.getEdge('tour1', 'hasDeparture', 'nonexistent');
      expect(edge).toBeNull();
    });
  });

  describe('edgeExists', () => {
    it('returns true for existing edge', async () => {
      const exists = await g.edgeExists('tour1', 'hasDeparture', 'dep1');
      expect(exists).toBe(true);
    });

    it('returns false for nonexistent edge', async () => {
      const exists = await g.edgeExists('tour1', 'hasDeparture', 'nonexistent');
      expect(exists).toBe(false);
    });
  });

  describe('findEdges', () => {
    it('forward lookup: {aUid, axbType} returns only matching edges', async () => {
      const edges = await g.findEdges({ aUid: 'tour1', axbType: 'hasDeparture' });
      expect(edges).toHaveLength(2);
      expect(edges.every((e) => e.aUid === 'tour1')).toBe(true);
      expect(edges.every((e) => e.axbType === 'hasDeparture')).toBe(true);
    });

    it('reverse lookup: {axbType, bUid} returns correct results', async () => {
      const edges = await g.findEdges({ axbType: 'hasDeparture', bUid: 'dep1' });
      expect(edges).toHaveLength(2);
      expect(edges.every((e) => e.bUid === 'dep1')).toBe(true);
    });

    it('smart optimization: {aUid, axbType, bUid} returns same as getEdge', async () => {
      const edges = await g.findEdges({ aUid: 'tour1', axbType: 'hasDeparture', bUid: 'dep1' });
      expect(edges).toHaveLength(1);
      expect(edges[0].aUid).toBe('tour1');
      expect(edges[0].bUid).toBe('dep1');
    });

    it('returns empty array when no matches', async () => {
      const edges = await g.findEdges({ aUid: 'tour1', axbType: 'nonexistentRelation' });
      expect(edges).toEqual([]);
    });

    it('type-scoped forward: {aType, axbType} returns edges from all entities of that type', async () => {
      const edges = await g.findEdges({ aType: 'tour', axbType: 'hasDeparture' });
      expect(edges).toHaveLength(3);
      expect(edges.every((e) => e.aType === 'tour')).toBe(true);
      expect(edges.every((e) => e.axbType === 'hasDeparture')).toBe(true);
    });

    it('type-scoped reverse: {axbType, bType} returns edges pointing to all entities of that type', async () => {
      const edges = await g.findEdges({ axbType: 'bookedForDeparture', bType: 'departure' });
      expect(edges).toHaveLength(1);
      expect(edges[0].bType).toBe('departure');
      expect(edges[0].axbType).toBe('bookedForDeparture');
    });
  });

  describe('findNodes', () => {
    it('returns only nodes of specified type', async () => {
      const nodes = await g.findNodes({ aType: 'tour' });
      expect(nodes).toHaveLength(2);
      expect(nodes.every((n) => n.aType === 'tour')).toBe(true);
    });

    it('returns empty array when no nodes match', async () => {
      const nodes = await g.findNodes({ aType: 'nonexistentType' });
      expect(nodes).toEqual([]);
    });
  });
});
