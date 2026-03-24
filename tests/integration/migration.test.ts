import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import { generateId } from '../../src/id.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';
import type { GraphClient, MigrationStep } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared schemas & migrations
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

const tourSchemaV2 = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string' },
    status: { type: 'string' },
    active: { type: 'boolean' },
  },
  additionalProperties: false,
};

const tourMigrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
  { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, active: true }) },
];

const edgeSchema = {
  type: 'object',
  properties: {
    order: { type: 'number' },
  },
  additionalProperties: false,
};

const edgeMigrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, order: d.order ?? 0 }) },
];

// ---------------------------------------------------------------------------
// Static registry migration — end-to-end
// ---------------------------------------------------------------------------

describe('migration — static registry', () => {
  const db = getTestFirestore();

  describe('version stamping on writes', () => {
    let g: GraphClient;

    beforeEach(() => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
        {
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          jsonSchema: edgeSchema,
          migrations: edgeMigrations,
        },
        {
          aType: 'departure',
          axbType: 'is',
          bType: 'departure',
        },
      ]);
      g = createGraphClient(db, uniqueCollectionPath(), { registry });
    });

    it('stamps v on putNode when entry has schemaVersion', async () => {
      const uid = generateId();
      await g.putNode('tour', uid, { title: 'My Tour' });

      const node = await g.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBe(2);
      expect(node!.data.title).toBe('My Tour');
    });

    it('stamps v on putEdge when entry has schemaVersion', async () => {
      const tourUid = generateId();
      const depUid = generateId();
      await g.putNode('tour', tourUid, { title: 'Tour' });
      await g.putNode('departure', depUid, {});
      await g.putEdge('tour', tourUid, 'hasDeparture', 'departure', depUid, { order: 5 });

      const edge = await g.getEdge(tourUid, 'hasDeparture', depUid);
      expect(edge).not.toBeNull();
      expect(edge!.v).toBe(1);
      expect(edge!.data.order).toBe(5);
    });

    it('does not stamp v when entry has no schemaVersion', async () => {
      const uid = generateId();
      await g.putNode('departure', uid, {});

      const node = await g.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBeUndefined();
    });
  });

  describe('auto-migration on read', () => {
    it('migrates v0 node data to current schema version', async () => {
      const collPath = uniqueCollectionPath();

      // Write without registry (simulates legacy data)
      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'Legacy Tour' });

      // Now create a client with registry + migrations
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const node = await g.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBe(2);
      expect(node!.data.status).toBe('draft');
      expect(node!.data.active).toBe(true);
      expect(node!.data.title).toBe('Legacy Tour');
    });

    it('migrates v0 edge data to current schema version', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const aUid = generateId();
      const bUid = generateId();
      await bare.putNode('tour', aUid, { title: 'T' });
      await bare.putNode('departure', bUid, {});
      await bare.putEdge('tour', aUid, 'hasDeparture', 'departure', bUid, {});

      const registry = createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
        { aType: 'departure', axbType: 'is', bType: 'departure' },
        {
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          jsonSchema: edgeSchema,
          migrations: edgeMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const edge = await g.getEdge(aUid, 'hasDeparture', bUid);
      expect(edge).not.toBeNull();
      expect(edge!.v).toBe(1);
      expect(edge!.data.order).toBe(0);
    });

    it('migrates from intermediate version (v1 -> v2)', async () => {
      const collPath = uniqueCollectionPath();

      // Write at v1 using a v1 registry
      const v1Registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV1,
          migrations: [tourMigrations[0]],
        },
      ]);
      const v1Client = createGraphClient(db, collPath, { registry: v1Registry });
      const uid = generateId();
      await v1Client.putNode('tour', uid, { title: 'Tour', status: 'active' });

      // Read with v2 registry — should only run v1->v2 migration
      const v2Registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const v2Client = createGraphClient(db, collPath, { registry: v2Registry });

      const node = await v2Client.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBe(2);
      expect(node!.data.active).toBe(true);
      // status should remain 'active', NOT be overwritten to 'draft'
      expect(node!.data.status).toBe('active');
    });

    it('does not migrate records already at current version', async () => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, uniqueCollectionPath(), { registry });

      const uid = generateId();
      await g.putNode('tour', uid, { title: 'Current', status: 'active', active: true });

      const node = await g.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBe(2);
      expect(node!.data.title).toBe('Current');
    });

    it('migrates records returned by findNodes', async () => {
      const collPath = uniqueCollectionPath();

      // Write legacy data
      const bare = createGraphClient(db, collPath);
      await bare.putNode('tour', generateId(), { title: 'Tour A' });
      await bare.putNode('tour', generateId(), { title: 'Tour B' });

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const nodes = await g.findNodes({ aType: 'tour' });
      expect(nodes).toHaveLength(2);
      for (const node of nodes) {
        expect(node.v).toBe(2);
        expect(node.data.status).toBe('draft');
        expect(node.data.active).toBe(true);
      }
    });

    it('migrates records returned by findEdges', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const aUid = generateId();
      const bUid1 = generateId();
      const bUid2 = generateId();
      await bare.putNode('tour', aUid, {});
      await bare.putNode('departure', bUid1, {});
      await bare.putNode('departure', bUid2, {});
      await bare.putEdge('tour', aUid, 'hasDeparture', 'departure', bUid1, {});
      await bare.putEdge('tour', aUid, 'hasDeparture', 'departure', bUid2, { order: 3 });

      const registry = createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
        { aType: 'departure', axbType: 'is', bType: 'departure' },
        {
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          jsonSchema: edgeSchema,
          migrations: edgeMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const edges = await g.findEdges({ aUid, axbType: 'hasDeparture' });
      expect(edges).toHaveLength(2);
      for (const edge of edges) {
        expect(edge.v).toBe(1);
        expect(typeof edge.data.order).toBe('number');
      }
    });

    it('edgeExists skips migration and returns boolean for legacy edge', async () => {
      const collPath = uniqueCollectionPath();

      // Write legacy edge without registry (no v field)
      const bare = createGraphClient(db, collPath);
      const tourUid = generateId();
      const depUid = generateId();
      await bare.putNode('tour', tourUid, { title: 'Tour' });
      await bare.putNode('departure', depUid, {});
      await bare.putEdge('tour', tourUid, 'hasDeparture', 'departure', depUid, {});

      // Create registry-aware client with migrations
      const registry = createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
        { aType: 'departure', axbType: 'is', bType: 'departure' },
        {
          aType: 'tour',
          axbType: 'hasDeparture',
          bType: 'departure',
          jsonSchema: edgeSchema,
          migrations: edgeMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      // edgeExists should return true without running migrations
      const exists = await g.edgeExists(tourUid, 'hasDeparture', depUid);
      expect(exists).toBe(true);

      // Non-existent edge should return false
      const missing = await g.edgeExists(tourUid, 'hasDeparture', generateId());
      expect(missing).toBe(false);

      // Verify getEdge DOES migrate (contrast with edgeExists)
      const edge = await g.getEdge(tourUid, 'hasDeparture', depUid);
      expect(edge).not.toBeNull();
      expect(edge!.v).toBe(1);
      expect(edge!.data.order).toBe(0);
    });
  });

  describe('transactions', () => {
    it('migrates records read inside a transaction', async () => {
      const collPath = uniqueCollectionPath();

      // Write legacy data
      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('tour', uid, { title: 'Legacy' });

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const result = await g.runTransaction(async (tx) => {
        const node = await tx.getNode(uid);
        return node;
      });

      expect(result).not.toBeNull();
      expect(result!.v).toBe(2);
      expect(result!.data.status).toBe('draft');
      expect(result!.data.active).toBe(true);
    });

    it('stamps v on putNode inside a transaction', async () => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, uniqueCollectionPath(), { registry });

      const uid = generateId();
      await g.runTransaction(async (tx) => {
        await tx.putNode('tour', uid, { title: 'TxTour', status: 'live', active: false });
      });

      const node = await g.getNode(uid);
      expect(node).not.toBeNull();
      expect(node!.v).toBe(2);
    });
  });

  describe('batch writes', () => {
    it('stamps v on putNode in batch', async () => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, uniqueCollectionPath(), { registry });

      const uid1 = generateId();
      const uid2 = generateId();
      const batch = g.batch();
      await batch.putNode('tour', uid1, { title: 'Batch1', status: 'x', active: true });
      await batch.putNode('tour', uid2, { title: 'Batch2', status: 'y', active: false });
      await batch.commit();

      const n1 = await g.getNode(uid1);
      const n2 = await g.getNode(uid2);
      expect(n1!.v).toBe(2);
      expect(n2!.v).toBe(2);
    });
  });

  describe('async migrations', () => {
    it('supports async migration functions', async () => {
      const collPath = uniqueCollectionPath();

      const bare = createGraphClient(db, collPath);
      const uid = generateId();
      await bare.putNode('task', uid, { name: 'Do it' });

      const registry = createRegistry([
        {
          aType: 'task',
          axbType: 'is',
          bType: 'task',
          migrations: [
            {
              fromVersion: 0,
              toVersion: 1,
              up: async (d) => {
                await new Promise((r) => setTimeout(r, 5));
                return { ...d, done: false };
              },
            },
          ],
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const node = await g.getNode(uid);
      expect(node!.v).toBe(1);
      expect(node!.data.done).toBe(false);
    });
  });

  describe('updateNode does not stamp v', () => {
    it('leaves v unchanged after partial update', async () => {
      const collPath = uniqueCollectionPath();

      // Write at v2 via registry
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          jsonSchema: tourSchemaV2,
          migrations: tourMigrations,
        },
      ]);
      const g = createGraphClient(db, collPath, { registry });

      const uid = generateId();
      await g.putNode('tour', uid, { title: 'Original', status: 'live', active: true });
      const written = await g.getNode(uid);
      expect(written!.v).toBe(2);

      // updateNode uses Firestore dot-path syntax for partial updates
      await g.updateNode(uid, { title: 'Updated' });

      // Read raw via bare client to verify v is unchanged
      const bare = createGraphClient(db, collPath);
      const raw = await bare.getNode(uid);
      expect(raw!.data.title).toBe('Updated');
      // v should remain 2 since updateNode is a raw partial update
      expect(raw!.v).toBe(2);
    });
  });

  describe('subgraph migration', () => {
    it('migrates records in a subgraph scope', async () => {
      const registry = createRegistry([
        {
          aType: 'task',
          axbType: 'is',
          bType: 'task',
          migrations: [
            { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, priority: 'normal' }) },
          ],
        },
      ]);

      const collPath = uniqueCollectionPath();

      // Write legacy data in root graph then read through subgraph parent
      const rootBare = createGraphClient(db, collPath);
      const parentUid = generateId();
      await rootBare.putNode('project', parentUid, { name: 'P' });

      // Write legacy task in subgraph without registry
      const subBare = createGraphClient(db, `${collPath}/${parentUid}/graph`);
      const taskUid = generateId();
      await subBare.putNode('task', taskUid, { name: 'T1' });

      // Now create registry-aware client and read through subgraph
      const root = createGraphClient(db, collPath, { registry });
      const sub = root.subgraph(parentUid);
      const task = await sub.getNode(taskUid);

      expect(task).not.toBeNull();
      expect(task!.v).toBe(1);
      expect(task!.data.priority).toBe('normal');
    });
  });
});
