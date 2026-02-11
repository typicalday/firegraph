import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError } from '../../src/errors.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';
import { tourData, riderData } from '../helpers/fixtures.js';
import { z } from 'zod';

describe('batch operations', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath());
  });

  it('atomic commit: all documents exist after commit', async () => {
    const batch = g.batch();
    await batch.putNode('rider', 'r1', { name: 'Rider 1' });
    await batch.putNode('rider', 'r2', { name: 'Rider 2' });
    await batch.putNode('rider', 'r3', { name: 'Rider 3' });
    await batch.putNode('rider', 'r4', { name: 'Rider 4' });
    await batch.putNode('rider', 'r5', { name: 'Rider 5' });
    await batch.commit();

    for (let i = 1; i <= 5; i++) {
      const node = await g.getNode(`r${i}`);
      expect(node).not.toBeNull();
      expect(node!.data.name).toBe(`Rider ${i}`);
    }
  });

  it('mixed operations: putNode + putEdge + removeEdge applied atomically', async () => {
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep-old', { order: 0 });

    const batch = g.batch();
    await batch.putNode('tour', 'tour1', tourData);
    await batch.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep-new', { order: 1 });
    await batch.removeEdge('tour1', 'hasDeparture', 'dep-old');
    await batch.commit();

    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();

    const newEdge = await g.getEdge('tour1', 'hasDeparture', 'dep-new');
    expect(newEdge).not.toBeNull();

    const oldEdge = await g.getEdge('tour1', 'hasDeparture', 'dep-old');
    expect(oldEdge).toBeNull();
  });

  it('registry violation during enqueue prevents commit', async () => {
    const registry = createRegistry([
      { aType: 'rider', abType: 'is', bType: 'rider', dataSchema: z.object({ name: z.string() }) },
    ]);
    const gWithRegistry = createGraphClient(db, uniqueCollectionPath(), { registry });

    const batch = gWithRegistry.batch();
    await batch.putNode('rider', 'r1', { name: 'Valid' });

    await expect(
      batch.putNode('unregistered', 'u1', { data: 'bad' }),
    ).rejects.toThrow(RegistryViolationError);
  });
});
