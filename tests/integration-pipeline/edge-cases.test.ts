/**
 * Pipeline Integration — Edge Case Tests
 *
 * Validates corner cases work correctly through pipeline mode:
 * empty data, deeply nested data, unicode, timestamps.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import {
  createPipelineClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient } from '../../src/types.js';

describe('pipeline edge cases', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(() => {
    g = createPipelineClient(collPath);
  });

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('putNode with empty data succeeds', async () => {
    await g.putNode('tour', 'ec-tour1', {});
    const node = await g.getNode('ec-tour1');
    expect(node).not.toBeNull();
    expect(node!.data).toEqual({});
  });

  it('putNode with deeply nested data succeeds', async () => {
    const deepData = {
      level1: {
        level2: {
          level3: {
            level4: {
              value: 'deep',
              array: [1, 2, { nested: true }],
            },
          },
        },
      },
    };
    await g.putNode('tour', 'ec-tour2', deepData);
    const node = await g.getNode('ec-tour2');
    expect(node!.data).toEqual(deepData);
  });

  it('entity types with unicode work', async () => {
    await g.putNode('turné', 'ec-id1', { name: 'Unicode Tour' });
    const node = await g.getNode('ec-id1');
    expect(node).not.toBeNull();
    expect(node!.aType).toBe('turné');
  });

  it('IDs with hyphens and underscores work', async () => {
    await g.putNode('tour', 'ec-my-tour_123', { name: 'Hyphen Test' });
    const node = await g.getNode('ec-my-tour_123');
    expect(node).not.toBeNull();
  });

  it('edge with unicode relationship type works', async () => {
    await g.putEdge('user', 'ec-u1', 'está-inscrito', 'event', 'ec-e1', {});
    const edge = await g.getEdge('ec-u1', 'está-inscrito', 'ec-e1');
    expect(edge).not.toBeNull();
    expect(edge!.axbType).toBe('está-inscrito');
  });

  it('createdAt and updatedAt are real Firestore Timestamps', async () => {
    await g.putNode('tour', 'ec-tour3', { name: 'Test' });
    const node = await g.getNode('ec-tour3');
    expect(node!.createdAt).toBeInstanceOf(Timestamp);
    expect(node!.updatedAt).toBeInstanceOf(Timestamp);
  });

  it('updatedAt changes on update but createdAt does not', async () => {
    await g.putNode('tour', 'ec-tour4', { name: 'Original' });
    const before = await g.getNode('ec-tour4');
    const createdBefore = before!.createdAt.toMillis();
    const updatedBefore = before!.updatedAt.toMillis();

    await new Promise((r) => setTimeout(r, 100));

    await g.updateNode('ec-tour4', { name: 'Updated' });
    const after = await g.getNode('ec-tour4');
    const createdAfter = after!.createdAt.toMillis();
    const updatedAfter = after!.updatedAt.toMillis();

    expect(createdAfter).toBe(createdBefore);
    expect(updatedAfter).toBeGreaterThan(updatedBefore);
  });

  it('pipeline findNodes returns nodes with unicode types', async () => {
    const results = await g.findNodes({ aType: 'turné' });
    expect(results.length).toBe(1);
    expect(results[0].data.name).toBe('Unicode Tour');
  });

  it('pipeline findEdges returns edges with unicode relation types', async () => {
    const results = await g.findEdges({ axbType: 'está-inscrito' });
    expect(results.length).toBe(1);
    expect(results[0].aUid).toBe('ec-u1');
  });

  it('pipeline query with deeply nested data filter', async () => {
    await g.putNode('config', 'ec-cfg1', { level1: { level2: { value: 'found' } } });
    await g.putNode('config', 'ec-cfg2', { level1: { level2: { value: 'other' } } });

    const results = await g.findEdges({
      aType: 'config',
      axbType: 'is',
      where: [{ field: 'level1.level2.value', op: '==', value: 'found' }],
    });
    expect(results.length).toBe(1);
    expect(results[0].aUid).toBe('ec-cfg1');
  });
});
