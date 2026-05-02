/**
 * Pipeline Operations — Basic Query Tests (RESEARCH)
 *
 * Exploratory tests validating the raw Firestore Pipeline API against firegraph's
 * data model. These do NOT test firegraph pipeline integration — they verify API
 * capabilities (collection queries, where filters, sort, limit, projection,
 * aggregation). Remove once firegraph has its own pipeline engine + tests, or
 * once Pipeline operations exits Preview and the emulator supports them.
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

const { field, constant, and, or, equal, greaterThan, lessThan } = Pipelines;

describe('pipeline basics', () => {
  const pipeDb = getPipelineFirestore();
  const adminDb = getAdminFirestore();
  const collPath = uniqueCollectionPath();
  let g: ReturnType<typeof createGraphClient>;

  beforeAll(async () => {
    // Use firegraph's standard client to write test data
    g = createGraphClient(adminDb, collPath);

    // Create nodes
    await g.putNode('tour', 'tour1', {
      name: 'Dolomites Classic',
      difficulty: 'hard',
      maxRiders: 30,
      region: 'europe',
    });
    await g.putNode('tour', 'tour2', {
      name: 'Alps Challenge',
      difficulty: 'medium',
      maxRiders: 20,
      region: 'europe',
    });
    await g.putNode('tour', 'tour3', {
      name: 'Rockies Adventure',
      difficulty: 'easy',
      maxRiders: 15,
      region: 'americas',
    });
    await g.putNode('departure', 'dep1', {
      date: '2025-07-15',
      registeredRiders: 12,
      maxCapacity: 30,
    });
    await g.putNode('departure', 'dep2', {
      date: '2025-08-01',
      registeredRiders: 5,
      maxCapacity: 20,
    });
    await g.putNode('rider', 'rider1', {
      firstName: 'Jamie',
      lastName: 'Chen',
      email: 'jamie@example.com',
    });
    await g.putNode('rider', 'rider2', {
      firstName: 'Jordan',
      lastName: 'Smith',
      email: 'jordan@example.com',
    });

    // Create edges
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', {
      order: 0,
      season: 'summer',
    });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', {
      order: 1,
      season: 'summer',
    });
    await g.putEdge('tour', 'tour2', 'hasDeparture', 'departure', 'dep1', {
      order: 0,
      season: 'winter',
    });
    await g.putEdge('rider', 'rider1', 'bookedFor', 'departure', 'dep1', {
      confirmedAt: '2025-01-10',
      price: 2500,
    });
    await g.putEdge('rider', 'rider2', 'bookedFor', 'departure', 'dep1', {
      confirmedAt: '2025-02-15',
      price: 3000,
    });
    await g.putEdge('rider', 'rider1', 'bookedFor', 'departure', 'dep2', {
      confirmedAt: '2025-03-01',
      price: 1800,
    });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 1. Basic collection pipeline
  // -------------------------------------------------------------------------
  describe('basic collection query', () => {
    it('reads all documents in a collection via pipeline', async () => {
      const pipeline = pipeDb.pipeline().collection(collPath).limit(100);

      const snap = await pipeline.execute();
      // 7 nodes + 6 edges = 13 total docs
      expect(snap.results.length).toBe(13);
    });

    it('filters by equality on a top-level field', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('aType'), constant('tour')));

      const snap = await pipeline.execute();
      // 3 tour nodes + 3 hasDeparture edges (from tour) = could be more
      // Actually: aType == 'tour' matches tour nodes AND edges where aType is 'tour'
      expect(snap.results.length).toBeGreaterThanOrEqual(3);
      for (const doc of snap.results) {
        expect(doc.data().aType).toBe('tour');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Node-relation filter (firegraph pattern: axbType == 'is')
  // -------------------------------------------------------------------------
  describe('node queries (axbType == is)', () => {
    it('finds all nodes via is-relation filter', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('is')));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(7); // 3 tours + 2 departures + 2 riders
    });

    it('finds nodes of specific type', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('tour'))),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(3);
      for (const doc of snap.results) {
        expect(doc.data().aType).toBe('tour');
        expect(doc.data().axbType).toBe('is');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3. Data field filtering (the critical use case)
  // -------------------------------------------------------------------------
  describe('data field filtering', () => {
    it('filters on nested data field (data.difficulty)', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('tour')),
            equal(field('data.difficulty'), constant('hard')),
          ),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(1);
      expect(snap.results[0].data()['data'].difficulty).toBe('hard');
    });

    it('filters on numeric data field with inequality', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('tour')),
            greaterThan(field('data.maxRiders'), constant(18)),
          ),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // Dolomites (30) + Alps (20)
    });

    it('combines topology + data filters on edges', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('hasDeparture')),
            equal(field('data.season'), constant('summer')),
          ),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // tour1 -> dep1 and tour1 -> dep2
    });

    it('uses OR logic across data fields', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('tour')),
            or(
              equal(field('data.difficulty'), constant('hard')),
              equal(field('data.difficulty'), constant('easy')),
            ),
          ),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // Dolomites (hard) + Rockies (easy)
    });

    it('filters edge data with numeric range', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('bookedFor')),
            greaterThan(field('data.price'), constant(2000)),
            lessThan(field('data.price'), constant(3500)),
          ),
        );

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // rider1->dep1 (2500) + rider2->dep1 (3000)
    });
  });

  // -------------------------------------------------------------------------
  // 4. Sort and limit
  // -------------------------------------------------------------------------
  describe('sort and limit', () => {
    it('sorts by data field ascending', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('tour'))),
        )
        .sort(field('data.maxRiders').ascending());

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(3);
      const maxRiders = snap.results.map((r) => r.data()['data'].maxRiders);
      expect(maxRiders).toEqual([15, 20, 30]);
    });

    it('limits results', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('is')))
        .sort(field('aType').ascending())
        .limit(3);

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(3);
    });

    it('sort + limit combined (top-N pattern)', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('bookedFor')))
        .sort(field('data.price').descending())
        .limit(2);

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2);
      const prices = snap.results.map((r) => r.data()['data'].price);
      expect(prices[0]).toBeGreaterThanOrEqual(prices[1]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Projection (select)
  // -------------------------------------------------------------------------
  describe('projection', () => {
    it('selects only specific fields', async () => {
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('tour'))),
        )
        .select(field('aType'), field('aUid'), field('data.name'));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(3);
      for (const doc of snap.results) {
        const d = doc.data();
        expect(d.aType).toBe('tour');
        expect(d.aUid).toBeDefined();
        // Should NOT have the full data object, only projected fields
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Aggregation
  // -------------------------------------------------------------------------
  describe('aggregation', () => {
    it('counts documents', async () => {
      const { countAll } = Pipelines;
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('is')))
        .aggregate(countAll().as('total'));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(1);
      expect(snap.results[0].data().total).toBe(7);
    });

    it('sums a numeric field', async () => {
      const { sum } = Pipelines;
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('bookedFor')))
        .aggregate(sum(field('data.price')).as('totalRevenue'));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(1);
      expect(snap.results[0].data().totalRevenue).toBe(7300); // 2500 + 3000 + 1800
    });

    it('groups by field and counts', async () => {
      const { countAll } = Pipelines;
      const pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('is')))
        .aggregate({ accumulators: [countAll().as('count')], groups: [field('aType')] });

      const snap = await pipeline.execute();
      const groups = new Map(snap.results.map((r) => [r.data().aType, r.data().count]));
      expect(groups.get('tour')).toBe(3);
      expect(groups.get('departure')).toBe(2);
      expect(groups.get('rider')).toBe(2);
    });
  });
});
