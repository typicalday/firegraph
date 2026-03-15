import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import { generateId } from '../../src/id.js';
import { computeNodeDocId, computeEdgeDocId } from '../../src/docid.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';
import type { GraphClient, MigrationStep } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tourSchemaV1 = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    status: { type: 'string' },
  },
  additionalProperties: false,
};

const tourMigrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
];

/**
 * Directly read a document from Firestore to inspect the raw stored data
 * (bypassing the GraphClient migration pipeline).
 */
async function readRawDoc(
  db: FirebaseFirestore.Firestore,
  collPath: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  const ref = db.collection(collPath).doc(docId);
  const snap = await ref.get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Write-back tests
// ---------------------------------------------------------------------------

describe('migration write-back', () => {
  const db = getTestFirestore();

  describe('eager write-back (entry-level)', () => {
    it('persists migrated data back to Firestore', async () => {
      const collPath = uniqueCollectionPath();

      // Write legacy v0 data
      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'Legacy' });

      // Create client with eager write-back at entry level
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          migrationWriteBack: 'eager',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      // Read triggers migration + eager write-back
      const node = await g.getNode(uid);
      expect(node!.v).toBe(1);
      expect(node!.data.status).toBe('draft');

      // Wait for the fire-and-forget write-back to complete
      await new Promise((r) => setTimeout(r, 500));

      // Verify the raw Firestore doc was updated
      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw).not.toBeNull();
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBe('draft');
    });
  });

  describe('eager write-back (global)', () => {
    it('persists migrated data when global write-back is eager', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'GlobalWB' });

      // Entry has no migrationWriteBack → falls back to global
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, {
        registry,
        migrationWriteBack: 'eager',
      });

      await g.getNode(uid);
      await new Promise((r) => setTimeout(r, 500));

      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBe('draft');
    });
  });

  describe('write-back off', () => {
    it('does not persist migrated data when write-back is off', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'NoWB' });

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          // explicit off
          migrationWriteBack: 'off',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      // Read triggers migration in memory but should NOT write back
      const node = await g.getNode(uid);
      expect(node!.v).toBe(1);
      expect(node!.data.status).toBe('draft');

      await new Promise((r) => setTimeout(r, 200));

      // Raw doc should still have v0 data
      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw!.v).toBeUndefined();
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBeUndefined();
    });
  });

  describe('two-tier resolution', () => {
    it('entry-level overrides global write-back', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'Override' });

      // Global is off, but entry is eager → entry wins
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          migrationWriteBack: 'eager',
        },
      ]);
      const g = createGraphClient(db, collPath, {
        registry,
        migrationWriteBack: 'off',
      });

      await g.getNode(uid);
      await new Promise((r) => setTimeout(r, 500));

      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBe('draft');
    });
  });

  describe('createdAt preservation', () => {
    it('preserves original createdAt on write-back', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'Timestamps' });

      // Capture original createdAt
      const original = await bare.getNode(uid);
      const originalCreatedAt = original!.createdAt;

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          migrationWriteBack: 'eager',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      await g.getNode(uid);
      await new Promise((r) => setTimeout(r, 500));

      // Read raw doc and verify createdAt is preserved (only updatedAt changes)
      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      // createdAt should be the same timestamp
      expect(raw!.createdAt).toEqual(originalCreatedAt);
    });
  });

  describe('background write-back', () => {
    it('persists migrated data via background write-back', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'BG' });

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          migrationWriteBack: 'background',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      await g.getNode(uid);
      await new Promise((r) => setTimeout(r, 500));

      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBe('draft');
    });
  });

  describe('transaction write-back', () => {
    it('persists migrated data within a transaction when write-back is not off', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'TxWB' });

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: tourMigrations,
          migrationWriteBack: 'eager',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      // Read inside transaction should also write-back within the tx
      await g.runTransaction(async (tx) => {
        const node = await tx.getNode(uid);
        expect(node!.v).toBe(1);
      });

      // The transaction write-back updates inline, so raw doc should reflect it
      const docId = computeNodeDocId(uid);
      const raw = await readRawDoc(db, collPath, docId);
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.status).toBe('draft');
    });
  });

  describe('edge write-back', () => {
    it('persists migrated edge data back to Firestore with correct sharded docId', async () => {
      const collPath = uniqueCollectionPath();
      const edgeSchema = {
        type: 'object',
        properties: { order: { type: 'number' } },
        additionalProperties: false,
      };
      const edgeMigrations: MigrationStep[] = [
        { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, order: d.order ?? 0 }) },
      ];

      // Write legacy edge without registry
      const bare = createGraphClient(db, collPath);
      const aUid = generateId();
      const bUid = generateId();
      await bare.putNode('tour', aUid, {});
      await bare.putNode('departure', bUid, {});
      await bare.putEdge('tour', aUid, 'hasDeparture', 'departure', bUid, {});

      // Create client with migration + eager write-back
      const registry = createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
        { aType: 'departure', axbType: 'is', bType: 'departure' },
        {
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          jsonSchema: edgeSchema,
          migrations: edgeMigrations,
          migrationWriteBack: 'eager',
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      // Read triggers migration + write-back
      const edge = await g.getEdge(aUid, 'hasDeparture', bUid);
      expect(edge!.v).toBe(1);
      expect(edge!.data.order).toBe(0);

      // Wait for fire-and-forget write-back
      await new Promise((r) => setTimeout(r, 500));

      // Verify the raw Firestore doc (sharded edge docId) was updated
      const edgeDocId = computeEdgeDocId(aUid, 'hasDeparture', bUid);
      const raw = await readRawDoc(db, collPath, edgeDocId);
      expect(raw).not.toBeNull();
      expect(raw!.v).toBe(1);
      const rawData = raw!.data as Record<string, unknown>;
      expect(rawData.order).toBe(0);
    });
  });
});
