/**
 * Pipeline Operations — Transaction Tests (RESEARCH)
 *
 * Exploratory tests investigating whether pipeline queries work inside Firestore
 * transactions. Findings: pipeline queries execute within transaction callbacks but
 * are NOT transactionally bound (they see committed state, not the transaction's
 * isolated view). Transaction objects do NOT have a .pipeline() method.
 *
 * Remove once firegraph has its own pipeline engine + tests, or once Pipeline
 * operations exits Preview and the emulator supports them.
 *
 * Requires: PIPELINE_TEST_PROJECT + PIPELINE_TEST_DATABASE env vars, ADC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../helpers/firestore-client.js';
import {
  cleanupCollection,
  getAdminFirestore,
  getPipelineFirestore,
  Pipelines,
  uniqueCollectionPath,
} from './setup.js';

const { field, constant, equal, and } = Pipelines;

describe('pipeline transactions', () => {
  const pipeDb = getPipelineFirestore();
  const adminDb = getAdminFirestore();
  const collPath = uniqueCollectionPath();
  let g: ReturnType<typeof createGraphClient>;

  beforeAll(async () => {
    g = createGraphClient(adminDb, collPath);
    await g.putNode('tour', 'txTour1', { name: 'Transaction Tour', difficulty: 'hard' });
    await g.putNode('tour', 'txTour2', { name: 'Another Tour', difficulty: 'easy' });
    await g.putEdge('tour', 'txTour1', 'hasDeparture', 'departure', 'txDep1', { order: 0 });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 1. Pipeline query inside a transaction (using @google-cloud/firestore)
  // -------------------------------------------------------------------------
  it('executes pipeline query inside a @google-cloud/firestore transaction', async () => {
    let pipelineResults: number = 0;

    await pipeDb.runTransaction(async (tx) => {
      // Attempt to run a pipeline query inside the transaction
      // This tests whether pipeline().execute() works within a transaction context
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('tour'))),
        );

      const snap = await pipeline.execute();
      pipelineResults = snap.results.length;

      // Also do a standard read in the same transaction
      const docRef = pipeDb.collection(collPath).doc('txTour1');
      const docSnap = await tx.get(docRef);
      expect(docSnap.exists).toBe(true);
    });

    expect(pipelineResults).toBe(2);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 2. Pipeline query + write in same transaction
  // -------------------------------------------------------------------------
  it('combines pipeline read with standard write in transaction', async () => {
    await pipeDb.runTransaction(async (tx) => {
      // Read via pipeline
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('tour'))),
        );

      const snap = await pipeline.execute();
      const tourCount = snap.results.length;

      // Write based on pipeline result
      const docRef = pipeDb.collection(collPath).doc('txMeta');
      tx.set(docRef, {
        aType: '_meta',
        aUid: 'txMeta',
        axbType: 'is',
        bType: '_meta',
        bUid: 'txMeta',
        data: { tourCount },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    // Verify the write
    const metaSnap = await pipeDb.collection(collPath).doc('txMeta').get();
    expect(metaSnap.exists).toBe(true);
    expect(metaSnap.data()?.data.tourCount).toBe(2);

    // Cleanup
    await pipeDb.collection(collPath).doc('txMeta').delete();
  }, 15_000);

  // -------------------------------------------------------------------------
  // 3. Test if pipeline is transactionally consistent
  // -------------------------------------------------------------------------
  it('pipeline inside transaction sees pre-transaction state', async () => {
    // Write a doc, then in a transaction: pipeline read + delete.
    // The pipeline should see the doc that will be deleted.
    const tempCollPath = uniqueCollectionPath();
    const tempRef = pipeDb.collection(tempCollPath).doc('tempDoc');
    await tempRef.set({
      aType: 'temp',
      aUid: 'tempDoc',
      axbType: 'is',
      bType: 'temp',
      bUid: 'tempDoc',
      data: { value: 42 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let seenInPipeline = false;

    await pipeDb.runTransaction(async (tx) => {
      const pipeline = pipeDb
        .pipeline()
        .collection(tempCollPath)
        .where(equal(field('aType'), constant('temp')));

      const snap = await pipeline.execute();
      seenInPipeline = snap.results.length > 0;

      // Delete the doc in the same transaction
      tx.delete(tempRef);
    });

    expect(seenInPipeline).toBe(true);

    // Doc should be gone after transaction
    const afterSnap = await tempRef.get();
    expect(afterSnap.exists).toBe(false);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 4. Test if pipeline supports transaction.get()-style binding
  // -------------------------------------------------------------------------
  it('checks if pipeline can be bound to a transaction context', async () => {
    // Some SDKs allow: tx.pipeline() or pipeline.withTransaction(tx)
    // Let's test what's available
    let hasTxPipeline = false;
    let txPipelineError: string | null = null;

    try {
      await pipeDb.runTransaction(async (tx) => {
        // Check if transaction has a pipeline method
        if (typeof (tx as any).pipeline === 'function') {
          hasTxPipeline = true;
          const pipeline = (tx as any)
            .pipeline()
            .collection(collPath)
            .where(equal(field('axbType'), constant('is')));

          await pipeline.execute();
        }

        // Regardless, do a standard get to keep the transaction valid
        const docRef = pipeDb.collection(collPath).doc('txTour1');
        await tx.get(docRef);
      });
    } catch (err: any) {
      txPipelineError = err.message;
    }

    // Report findings — this is exploratory, not a pass/fail assertion
    console.log('[pipeline-transactions] Transaction has .pipeline():', hasTxPipeline);
    if (txPipelineError) {
      console.log('[pipeline-transactions] tx.pipeline() error:', txPipelineError);
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // 5. Transaction with pipeline read + standard write (single SDK)
  // -------------------------------------------------------------------------
  it('combines pipeline read with transactional write in single SDK', async () => {
    let pipelineCount = 0;

    await pipeDb.runTransaction(async (tx) => {
      // Pipeline read (not transactionally bound, but within the callback)
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('hasDeparture')));

      const snap = await pipeline.execute();
      pipelineCount = snap.results.length;

      // Standard write via transaction
      const docRef = pipeDb.collection(collPath).doc('txEdgeCount');
      tx.set(docRef, {
        aType: '_meta',
        aUid: 'txEdgeCount',
        axbType: 'is',
        bType: '_meta',
        bUid: 'txEdgeCount',
        data: { edgeCount: pipelineCount },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    expect(pipelineCount).toBe(1);

    // Cleanup
    await pipeDb.collection(collPath).doc('txEdgeCount').delete();
  }, 15_000);
});
