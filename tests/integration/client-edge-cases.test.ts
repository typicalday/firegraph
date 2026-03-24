import { describe, it, expect, beforeEach } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import { createGraphClient } from '../../src/client.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

describe('client edge cases', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath());
  });

  it('putNode with empty data succeeds', async () => {
    await g.putNode('tour', 'tour1', {});
    const node = await g.getNode('tour1');
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
    await g.putNode('tour', 'tour1', deepData);
    const node = await g.getNode('tour1');
    expect(node!.data).toEqual(deepData);
  });

  it('entity types with unicode work', async () => {
    await g.putNode('turné', 'id1', { name: 'Unicode Tour' });
    const node = await g.getNode('id1');
    expect(node).not.toBeNull();
    expect(node!.aType).toBe('turné');
  });

  it('IDs with hyphens and underscores work', async () => {
    await g.putNode('tour', 'my-tour_123', { name: 'Hyphen Test' });
    const node = await g.getNode('my-tour_123');
    expect(node).not.toBeNull();
  });

  it('edge with unicode relationship type works', async () => {
    await g.putEdge('user', 'u1', 'está-inscrito', 'event', 'e1', {});
    const edge = await g.getEdge('u1', 'está-inscrito', 'e1');
    expect(edge).not.toBeNull();
    expect(edge!.axbType).toBe('está-inscrito');
  });

  it('createdAt and updatedAt are real Firestore Timestamps', async () => {
    await g.putNode('tour', 'tour1', { name: 'Test' });
    const node = await g.getNode('tour1');
    expect(node!.createdAt).toBeInstanceOf(Timestamp);
    expect(node!.updatedAt).toBeInstanceOf(Timestamp);
  });

  it('updatedAt changes on update but createdAt does not', async () => {
    await g.putNode('tour', 'tour1', { name: 'Original' });
    const before = await g.getNode('tour1');
    const createdBefore = before!.createdAt.toMillis();
    const updatedBefore = before!.updatedAt.toMillis();

    await new Promise((r) => setTimeout(r, 50));

    await g.updateNode('tour1', { name: 'Updated' });
    const after = await g.getNode('tour1');
    const createdAfter = after!.createdAt.toMillis();
    const updatedAfter = after!.updatedAt.toMillis();

    expect(createdAfter).toBe(createdBefore);
    expect(updatedAfter).toBeGreaterThan(updatedBefore);
  });
});
