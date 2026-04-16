import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GraphClient } from '../../src/types.js';
import { departureData, tourData } from '../helpers/fixtures.js';
import { createTestGraphClient, ensureSqliteBackend, uniqueCollectionPath } from './setup.js';

describe('transactions', () => {
  let g: GraphClient;

  beforeAll(async () => {
    await ensureSqliteBackend();
  });

  beforeEach(() => {
    g = createTestGraphClient(uniqueCollectionPath());
  });

  it('read-then-write: data persists after transaction', async () => {
    await g.putNode('departure', 'dep1', departureData);

    await g.runTransaction(async (tx) => {
      const dep = await tx.getNode('dep1');
      await tx.updateNode('dep1', {
        registeredRiders: (dep!.data.registeredRiders as number) + 1,
      });
    });

    const updated = await g.getNode('dep1');
    expect(updated!.data.registeredRiders).toBe(1);
  });

  it('rollback on error: no writes persist', async () => {
    await g.putNode('tour', 'tour1', tourData);

    await expect(
      g.runTransaction(async (tx) => {
        await tx.updateNode('tour1', { name: 'Should Not Persist' });
        throw new Error('Intentional rollback');
      }),
    ).rejects.toThrow('Intentional rollback');

    const node = await g.getNode('tour1');
    expect(node!.data.name).toBe('Dolomites Classic');
  });

  it('conditional write: read, check, write', async () => {
    await g.putNode('departure', 'dep1', { ...departureData, maxCapacity: 2, registeredRiders: 1 });

    await g.runTransaction(async (tx) => {
      const dep = await tx.getNode('dep1');
      const registered = dep!.data.registeredRiders as number;
      const max = dep!.data.maxCapacity as number;
      if (registered < max) {
        await tx.updateNode('dep1', { registeredRiders: registered + 1 });
      }
    });

    const dep = await g.getNode('dep1');
    expect(dep!.data.registeredRiders).toBe(2);
  });

  it('transaction supports putNode and putEdge', async () => {
    await g.runTransaction(async (tx) => {
      await tx.putNode('tour', 'tour1', tourData);
      await tx.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    });

    const node = await g.getNode('tour1');
    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(node).not.toBeNull();
    expect(edge).not.toBeNull();
  });

  it('transaction supports removeNode and removeEdge', async () => {
    await g.putNode('tour', 'tour1', tourData);
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });

    await g.runTransaction(async (tx) => {
      await tx.removeEdge('tour1', 'hasDeparture', 'dep1');
      await tx.removeNode('tour1');
    });

    const node = await g.getNode('tour1');
    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(node).toBeNull();
    expect(edge).toBeNull();
  });

  it('transaction supports findEdges', async () => {
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });

    const edges = await g.runTransaction(async (tx) => {
      return tx.findEdges({ aUid: 'tour1', axbType: 'hasDeparture' });
    });

    expect(edges).toHaveLength(2);
  });
});
