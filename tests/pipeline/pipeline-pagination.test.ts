/**
 * Pipeline Operations — Pagination Tests (RESEARCH)
 *
 * Exploratory tests for pagination patterns with pipeline operations (no built-in
 * cursor/startAfter). Findings: offset() works (undocumented), keyset pagination
 * (sort + where > lastValue) works well.
 *
 * Remove once firegraph has its own pipeline engine + tests, or once Pipeline
 * operations exits Preview and the emulator supports them.
 *
 * Requires: PIPELINE_TEST_PROJECT + PIPELINE_TEST_DATABASE env vars, ADC.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/firestore.js';
import {
  cleanupCollection,
  getAdminFirestore,
  getPipelineFirestore,
  Pipelines,
  uniqueCollectionPath,
} from './setup.js';

const { field, constant, equal, and, greaterThan } = Pipelines;

describe('pipeline pagination', () => {
  const pipeDb = getPipelineFirestore();
  const adminDb = getAdminFirestore();
  const collPath = uniqueCollectionPath();
  let g: ReturnType<typeof createGraphClient>;

  // Create 20 nodes for pagination testing
  beforeAll(async () => {
    g = createGraphClient(adminDb, collPath);

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      const padded = String(i).padStart(3, '0');
      writes.push(
        g.putNode('item', `item${padded}`, {
          title: `Item ${padded}`,
          index: i,
          category: i < 10 ? 'A' : 'B',
        }),
      );
    }
    await Promise.all(writes);
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  // -------------------------------------------------------------------------
  // 1. Offset-based pagination
  // -------------------------------------------------------------------------
  describe('offset-based', () => {
    it('checks if pipeline supports offset()', async () => {
      let supportsOffset = false;
      let offsetError: string | null = null;

      try {
        const pipeline = pipeDb
          .pipeline()
          .collection(collPath)
          .where(
            and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('item'))),
          )
          .sort(field('data.index').ascending());

        // Try offset if available
        if (typeof (pipeline as any).offset === 'function') {
          supportsOffset = true;
          const snap = await (pipeline as any).offset(5).limit(5).execute();
          expect(snap.results.length).toBe(5);
          // Should be items 5-9
          const indices = snap.results.map((r: any) => r.data()['data'].index);
          expect(indices[0]).toBe(5);
        }
      } catch (err: any) {
        offsetError = err.message;
      }

      console.log('[pagination] Pipeline supports offset():', supportsOffset);
      if (offsetError) console.log('[pagination] offset() error:', offsetError);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Keyset pagination (sort + where on last-seen value)
  // -------------------------------------------------------------------------
  describe('keyset pagination', () => {
    it('paginates via sort + where on data.index', async () => {
      const pageSize = 5;
      const allItems: number[] = [];

      // Page 1: first 5
      const page1Pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('item'))),
        )
        .sort(field('data.index').ascending())
        .limit(pageSize);

      const page1 = await page1Pipeline.execute();
      expect(page1.results.length).toBe(5);
      const page1Indices = page1.results.map((r) => r.data()['data'].index as number);
      allItems.push(...page1Indices);

      // Page 2: next 5 (where index > last from page 1)
      const lastIndex = page1Indices[page1Indices.length - 1];
      const page2Pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('item')),
            greaterThan(field('data.index'), constant(lastIndex)),
          ),
        )
        .sort(field('data.index').ascending())
        .limit(pageSize);

      const page2 = await page2Pipeline.execute();
      expect(page2.results.length).toBe(5);
      const page2Indices = page2.results.map((r) => r.data()['data'].index as number);
      allItems.push(...page2Indices);

      // Page 3
      const lastIndex2 = page2Indices[page2Indices.length - 1];
      const page3Pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('item')),
            greaterThan(field('data.index'), constant(lastIndex2)),
          ),
        )
        .sort(field('data.index').ascending())
        .limit(pageSize);

      const page3 = await page3Pipeline.execute();
      expect(page3.results.length).toBe(5);
      allItems.push(...page3.results.map((r) => r.data()['data'].index as number));

      // Page 4
      const lastIndex3 = page3.results.map((r) => r.data()['data'].index as number).pop()!;
      const page4Pipeline = pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('item')),
            greaterThan(field('data.index'), constant(lastIndex3)),
          ),
        )
        .sort(field('data.index').ascending())
        .limit(pageSize);

      const page4 = await page4Pipeline.execute();
      expect(page4.results.length).toBe(5);
      allItems.push(...page4.results.map((r) => r.data()['data'].index as number));

      // Should have all 20 items, in order, no duplicates
      expect(allItems).toEqual(Array.from({ length: 20 }, (_, i) => i));
    }, 30_000);

    it('keyset pagination on document ID (aUid)', async () => {
      const pageSize = 5;

      // Page 1
      const page1 = await pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(equal(field('axbType'), constant('is')), equal(field('aType'), constant('item'))),
        )
        .sort(field('aUid').ascending())
        .limit(pageSize)
        .execute();

      expect(page1.results.length).toBe(5);

      // Page 2: aUid > last
      const lastUid = page1.results[page1.results.length - 1].data().aUid;
      const page2 = await pipeDb
        .pipeline()
        .collection(collPath)
        .where(
          and(
            equal(field('axbType'), constant('is')),
            equal(field('aType'), constant('item')),
            greaterThan(field('aUid'), constant(lastUid)),
          ),
        )
        .sort(field('aUid').ascending())
        .limit(pageSize)
        .execute();

      expect(page2.results.length).toBe(5);

      // No overlap
      const page1Uids = new Set(page1.results.map((r) => r.data().aUid));
      for (const r of page2.results) {
        expect(page1Uids.has(r.data().aUid)).toBe(false);
      }
    }, 15_000);
  });

  // -------------------------------------------------------------------------
  // 3. Filtered pagination (topology + data filter + keyset)
  // -------------------------------------------------------------------------
  describe('filtered keyset pagination', () => {
    it('paginates within a filtered subset', async () => {
      // Only category A items (0-9), paginated in groups of 3
      const pageSize = 3;
      const allIndices: number[] = [];
      let cursor: number | null = null;

      for (let page = 0; page < 4; page++) {
        const conditions = [
          equal(field('axbType'), constant('is')),
          equal(field('aType'), constant('item')),
          equal(field('data.category'), constant('A')),
        ];
        if (cursor !== null) {
          conditions.push(greaterThan(field('data.index'), constant(cursor)));
        }

        const snap = await pipeDb
          .pipeline()
          .collection(collPath)
          .where(and(...conditions))
          .sort(field('data.index').ascending())
          .limit(pageSize)
          .execute();

        if (snap.results.length === 0) break;

        const indices = snap.results.map((r) => r.data()['data'].index as number);
        allIndices.push(...indices);
        cursor = indices[indices.length - 1];
      }

      // Category A has items 0-9
      expect(allIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }, 30_000);
  });
});
