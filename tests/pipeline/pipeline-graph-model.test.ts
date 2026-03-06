/**
 * Pipeline Operations — Firegraph Graph Model Tests (RESEARCH)
 *
 * Exploratory tests validating pipeline operations against firegraph's actual
 * data model: single collection with nodes (self-loops) and edges, sharded
 * document IDs, mixed topology + data queries, multi-hop patterns, and the
 * critical "data field filter without composite index" scenario.
 *
 * Remove once firegraph has its own pipeline engine + tests, or once Pipeline
 * operations exits Preview and the emulator supports them.
 *
 * Requires: PIPELINE_TEST_PROJECT + PIPELINE_TEST_DATABASE env vars, ADC.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getPipelineFirestore,
  getAdminFirestore,
  uniqueCollectionPath,
  cleanupCollection,
  Pipelines,
} from './setup.js';
import { createGraphClient } from '../../src/client.js';

const {
  field, constant, and, or, equal, greaterThan, lessThan,
  ascending, descending, countAll, sum, average, minimum, maximum,
  regexMatch, startsWith,
} = Pipelines;

describe('pipeline graph model', () => {
  const pipeDb = getPipelineFirestore();
  const adminDb = getAdminFirestore();
  const collPath = uniqueCollectionPath();
  let g: ReturnType<typeof createGraphClient>;

  beforeAll(async () => {
    g = createGraphClient(adminDb, collPath);

    // Build a realistic graph:
    // Tours -> Departures -> Riders
    await g.putNode('tour', 'tourA', { name: 'Dolomites Classic', difficulty: 'hard', price: 5000, region: 'europe' });
    await g.putNode('tour', 'tourB', { name: 'Alps Easy', difficulty: 'easy', price: 2000, region: 'europe' });
    await g.putNode('tour', 'tourC', { name: 'Colorado Trail', difficulty: 'medium', price: 3500, region: 'americas' });

    await g.putNode('departure', 'depX', { date: '2025-07-15', spotsLeft: 5, status: 'open' });
    await g.putNode('departure', 'depY', { date: '2025-08-01', spotsLeft: 0, status: 'full' });
    await g.putNode('departure', 'depZ', { date: '2025-09-10', spotsLeft: 12, status: 'open' });

    await g.putNode('rider', 'r1', { firstName: 'Jamie', lastName: 'Chen', level: 'pro' });
    await g.putNode('rider', 'r2', { firstName: 'Jordan', lastName: 'Smith', level: 'intermediate' });
    await g.putNode('rider', 'r3', { firstName: 'Casey', lastName: 'Lee', level: 'beginner' });

    // Edges: tours -> departures
    await g.putEdge('tour', 'tourA', 'hasDeparture', 'departure', 'depX', { order: 0, guide: 'Marco' });
    await g.putEdge('tour', 'tourA', 'hasDeparture', 'departure', 'depY', { order: 1, guide: 'Luca' });
    await g.putEdge('tour', 'tourB', 'hasDeparture', 'departure', 'depZ', { order: 0, guide: 'Marco' });
    await g.putEdge('tour', 'tourC', 'hasDeparture', 'departure', 'depX', { order: 0, guide: 'Sarah' });

    // Edges: riders -> departures (bookings)
    await g.putEdge('rider', 'r1', 'bookedFor', 'departure', 'depX', { price: 5000, paid: true });
    await g.putEdge('rider', 'r2', 'bookedFor', 'departure', 'depX', { price: 4500, paid: true });
    await g.putEdge('rider', 'r3', 'bookedFor', 'departure', 'depY', { price: 5000, paid: false });
    await g.putEdge('rider', 'r1', 'bookedFor', 'departure', 'depZ', { price: 2000, paid: true });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 1. The critical scenario: topology + data filter without explicit index
  //    This is where pipeline shines over Core operations.
  // -------------------------------------------------------------------------
  describe('topology + data filter (no explicit index needed)', () => {
    it('finds edges by axbType + data field (the dangerous query in Core mode)', async () => {
      // In Standard Firestore, this would require a composite index on
      // (axbType, data.guide) or do a full collection scan.
      // With Pipeline Enterprise, it should use axbType index and scan subset.
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('hasDeparture')),
          equal(field('data.guide'), constant('Marco')),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // tourA->depX + tourB->depZ
      for (const r of snap.results) {
        expect(r.data()['data'].guide).toBe('Marco');
      }
    });

    it('finds nodes by type + multiple data conditions', async () => {
      // aType == 'tour' AND data.region == 'europe' AND data.price > 3000
      // Three-field filter — no composite index for this combination
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('is')),
          equal(field('aType'), constant('tour')),
          equal(field('data.region'), constant('europe')),
          greaterThan(field('data.price'), constant(3000)),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(1); // Only Dolomites (5000, europe)
      expect(snap.results[0].data()['data'].name).toBe('Dolomites Classic');
    });

    it('filters edges by data range without composite index', async () => {
      // bookedFor edges where 2000 < price <= 5000 AND paid == true
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('bookedFor')),
          greaterThan(field('data.price'), constant(2000)),
          equal(field('data.paid'), constant(true)),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // r1->depX (5000,true) + r2->depX (4500,true)
    });
  });

  // -------------------------------------------------------------------------
  // 2. Reverse lookups (find who points to a node)
  // -------------------------------------------------------------------------
  describe('reverse lookups', () => {
    it('finds all edges pointing to a specific node', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(equal(field('bUid'), constant('depX')));

      const snap = await pipeline.execute();
      // hasDeparture edges: tourA->depX, tourC->depX
      // bookedFor edges: r1->depX, r2->depX
      // Plus depX node itself (bUid == depX for self-loop)
      expect(snap.results.length).toBe(5);
    });

    it('finds incoming edges of specific type to a node', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('bookedFor')),
          equal(field('bUid'), constant('depX')),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2); // r1 + r2
    });
  });

  // -------------------------------------------------------------------------
  // 3. Graph aggregation queries
  // -------------------------------------------------------------------------
  describe('graph aggregations', () => {
    it('counts edges per relation type', async () => {
      const { notEqual } = Pipelines;
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(
          // Exclude node self-loops
          notEqual(field('axbType'), constant('is')),
        )
        .aggregate({
          accumulators: [countAll().as('edgeCount')],
          groups: [field('axbType')],
        });

      const snap = await pipeline.execute();
      const groups = new Map(snap.results.map(r => [r.data().axbType, r.data().edgeCount]));
      expect(groups.get('hasDeparture')).toBe(4);
      expect(groups.get('bookedFor')).toBe(4);
    });

    it('sums booking revenue per departure', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('bookedFor')))
        .aggregate({
          accumulators: [
            sum(field('data.price')).as('totalRevenue'),
            countAll().as('bookingCount'),
          ],
          groups: [field('bUid')],
        });

      const snap = await pipeline.execute();
      const byDep = new Map(snap.results.map(r => [
        r.data().bUid,
        { revenue: r.data().totalRevenue, count: r.data().bookingCount },
      ]));

      expect(byDep.get('depX')).toEqual({ revenue: 9500, count: 2 });
      expect(byDep.get('depY')).toEqual({ revenue: 5000, count: 1 });
      expect(byDep.get('depZ')).toEqual({ revenue: 2000, count: 1 });
    });

    it('computes average booking price', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('bookedFor')))
        .aggregate(average(field('data.price')).as('avgPrice'));

      const snap = await pipeline.execute();
      // (5000 + 4500 + 5000 + 2000) / 4 = 4125
      expect(snap.results[0].data().avgPrice).toBe(4125);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-hop traversal pattern via pipeline
  //    (what firegraph's createTraversal does with multiple queries)
  // -------------------------------------------------------------------------
  describe('multi-hop traversal patterns', () => {
    it('two-hop: tour -> departures -> riders (manual join)', async () => {
      // Hop 1: Find departures for tourA
      const hop1 = await pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('aUid'), constant('tourA')),
          equal(field('axbType'), constant('hasDeparture')),
        ))
        .execute();

      const depUids = hop1.results.map(r => r.data().bUid as string);
      expect(depUids.sort()).toEqual(['depX', 'depY']);

      // Hop 2: Find riders booked for those departures
      // Pipeline supports OR over the list of bUids
      const hop2 = await pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('bookedFor')),
          or(...depUids.map(uid => equal(field('bUid'), constant(uid)))),
        ))
        .execute();

      const riderUids = hop2.results.map(r => r.data().aUid as string);
      expect(riderUids.sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('finds all node types connected to a specific node', async () => {
      // Find all edge types going out of tourA
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(equal(field('aUid'), constant('tourA')))
        .where(field('axbType').notEqual(constant('is')));

      const snap = await pipeline.execute();
      const edgeTypes = [...new Set(snap.results.map(r => r.data().axbType))];
      expect(edgeTypes).toEqual(['hasDeparture']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. String / regex operations (Pipeline-only features)
  // -------------------------------------------------------------------------
  describe('advanced expressions (pipeline-only)', () => {
    it('filters with startsWith on data field', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('is')),
          equal(field('aType'), constant('tour')),
          startsWith(field('data.name'), constant('Dol')),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(1);
      expect(snap.results[0].data()['data'].name).toBe('Dolomites Classic');
    });

    it('filters with regex on data field', async () => {
      const pipeline = pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('is')),
          equal(field('aType'), constant('rider')),
          regexMatch(field('data.lastName'), constant('^(Chen|Lee)$')),
        ));

      const snap = await pipeline.execute();
      expect(snap.results.length).toBe(2);
      const names = snap.results.map(r => r.data()['data'].lastName).sort();
      expect(names).toEqual(['Chen', 'Lee']);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Performance comparison: pipeline vs core for same query
  // -------------------------------------------------------------------------
  describe('pipeline vs core comparison', () => {
    it('same query via pipeline and core returns same results', async () => {
      // Pipeline query
      const pipeSnap = await pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('hasDeparture')),
          equal(field('aUid'), constant('tourA')),
        ))
        .sort(field('data.order').ascending())
        .execute();

      // Core query via firegraph client
      const coreResults = await g.findEdges({
        aUid: 'tourA',
        axbType: 'hasDeparture',
        orderBy: { field: 'data.order', direction: 'asc' },
      });

      // Same results
      expect(pipeSnap.results.length).toBe(coreResults.length);
      expect(pipeSnap.results.length).toBe(2);

      // Same order
      const pipeOrders = pipeSnap.results.map(r => r.data()['data'].order);
      const coreOrders = coreResults.map(r => r.data.order);
      expect(pipeOrders).toEqual(coreOrders);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Edge cases in single-collection model
  // -------------------------------------------------------------------------
  describe('single-collection edge cases', () => {
    it('distinguishes nodes from edges in same collection', async () => {
      const nodesSnap = await pipeDb.pipeline()
        .collection(collPath)
        .where(equal(field('axbType'), constant('is')))
        .execute();

      const edgesSnap = await pipeDb.pipeline()
        .collection(collPath)
        .where(field('axbType').notEqual(constant('is')))
        .execute();

      expect(nodesSnap.results.length).toBe(9); // 3 tours + 3 departures + 3 riders
      expect(edgesSnap.results.length).toBe(8); // 4 hasDeparture + 4 bookedFor
      expect(nodesSnap.results.length + edgesSnap.results.length).toBe(17);
    });

    it('handles queries that match zero documents', async () => {
      const snap = await pipeDb.pipeline()
        .collection(collPath)
        .where(and(
          equal(field('axbType'), constant('nonexistentRelation')),
          equal(field('aType'), constant('ghost')),
        ))
        .execute();

      expect(snap.results.length).toBe(0);
    });
  });
});
