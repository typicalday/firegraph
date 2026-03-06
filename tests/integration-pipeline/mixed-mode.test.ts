/**
 * Pipeline Integration — Mixed Mode Tests
 *
 * Validates that transactions always use standard queries even when the
 * client is in pipeline mode, and that both modes coexist correctly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  createStandardClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import type { GraphClient } from '../../src/types.js';

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

  it('transactions use standard queries (read + write)', async () => {
    // Even in pipeline mode, runTransaction should work because
    // GraphTransactionImpl always uses TransactionAdapter (standard)
    await pipeline.runTransaction(async (tx) => {
      const node = await tx.getNode('mx1');
      expect(node).not.toBeNull();
      expect(node!.data.name).toBe('Mixed Tour');

      // findEdges inside transaction uses standard adapter
      const edges = await tx.findEdges({ aUid: 'mx1', axbType: 'hasDeparture' });
      expect(edges.length).toBe(1);

      // Write inside transaction
      await tx.putNode('tour', 'mx3', { name: 'Tx Tour' });
    });

    // Verify the transaction write committed
    const node = await pipeline.getNode('mx3');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Tx Tour');
  });

  it('pipeline and standard clients read same data', async () => {
    const standard = createStandardClient(collPath);

    const [pipeNode, stdNode] = await Promise.all([
      pipeline.getNode('mx1'),
      standard.getNode('mx1'),
    ]);
    expect(pipeNode!.data).toEqual(stdNode!.data);

    const [pipeEdges, stdEdges] = await Promise.all([
      pipeline.findEdges({ axbType: 'hasDeparture' }),
      standard.findEdges({ axbType: 'hasDeparture' }),
    ]);
    expect(pipeEdges.length).toBe(stdEdges.length);
  });

  it('batch writes work in pipeline mode', async () => {
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
});
