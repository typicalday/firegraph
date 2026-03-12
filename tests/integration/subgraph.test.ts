import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import { RegistryScopeError } from '../../src/errors.js';
import { generateId } from '../../src/id.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};

const memorySchema = {
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string' } },
  additionalProperties: false,
};

const linkSchema = {
  type: 'object',
  properties: { weight: { type: 'number' } },
  additionalProperties: false,
};

describe('subgraph', () => {
  const db = getTestFirestore();
  let collectionPath: string;

  beforeEach(() => {
    collectionPath = uniqueCollectionPath();
  });

  describe('basic CRUD', () => {
    it('putNode + getNode in a subgraph', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent1' });

      const sub = g.subgraph(parentUid, 'memories');
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'hello' });

      const node = await sub.getNode(memUid);
      expect(node).not.toBeNull();
      expect(node!.aType).toBe('memory');
      expect(node!.data).toEqual({ text: 'hello' });
    });

    it('putEdge + getEdge in a subgraph', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent1' });

      const sub = g.subgraph(parentUid, 'memories');
      const m1 = generateId();
      const m2 = generateId();
      await sub.putNode('memory', m1, { text: 'a' });
      await sub.putNode('memory', m2, { text: 'b' });
      await sub.putEdge('memory', m1, 'linksTo', 'memory', m2, { weight: 0.5 });

      const edge = await sub.getEdge(m1, 'linksTo', m2);
      expect(edge).not.toBeNull();
      expect(edge!.data).toEqual({ weight: 0.5 });
    });

    it('findNodes in a subgraph only returns subgraph data', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('memory', parentUid, { text: 'root-level memory' });

      const sub = g.subgraph(parentUid, 'memories');
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'sub-level memory' });

      const rootNodes = await g.findNodes({ aType: 'memory', allowCollectionScan: true });
      const subNodes = await sub.findNodes({ aType: 'memory', allowCollectionScan: true });

      expect(rootNodes).toHaveLength(1);
      expect(rootNodes[0].data).toEqual({ text: 'root-level memory' });
      expect(subNodes).toHaveLength(1);
      expect(subNodes[0].data).toEqual({ text: 'sub-level memory' });
    });
  });

  describe('namespace isolation', () => {
    it('same UID in parent and subgraph are independent', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      const sharedUid = generateId();

      await g.putNode('agent', parentUid, { name: 'Agent' });
      await g.putNode('thing', sharedUid, { name: 'root-thing' });

      const sub = g.subgraph(parentUid);
      await sub.putNode('thing', sharedUid, { name: 'sub-thing' });

      const rootNode = await g.getNode(sharedUid);
      const subNode = await sub.getNode(sharedUid);

      expect(rootNode!.data).toEqual({ name: 'root-thing' });
      expect(subNode!.data).toEqual({ name: 'sub-thing' });
    });
  });

  describe('nested subgraphs', () => {
    it('supports multi-level nesting', async () => {
      const g = createGraphClient(db, collectionPath);
      const agentUid = generateId();
      await g.putNode('agent', agentUid, { name: 'Agent' });

      const level1 = g.subgraph(agentUid, 'workspace');
      const taskUid = generateId();
      await level1.putNode('task', taskUid, { name: 'Task' });

      const level2 = level1.subgraph(taskUid, 'subtasks');
      const subtaskUid = generateId();
      await level2.putNode('subtask', subtaskUid, { name: 'Subtask' });

      const node = await level2.getNode(subtaskUid);
      expect(node).not.toBeNull();
      expect(node!.data).toEqual({ name: 'Subtask' });

      // Level 1 shouldn't see level 2 nodes
      const l1nodes = await level1.findNodes({ aType: 'subtask', allowCollectionScan: true });
      expect(l1nodes).toHaveLength(0);
    });
  });

  describe('registry sharing + scope enforcement', () => {
    it('validates data through shared registry in subgraph', async () => {
      const registry = createRegistry([
        { aType: 'agent', axbType: 'is', bType: 'agent' },
        { aType: 'memory', axbType: 'is', bType: 'memory', jsonSchema: memorySchema },
      ]);
      const g = createGraphClient(db, collectionPath, { registry });
      const agentUid = generateId();
      await g.putNode('agent', agentUid, {});

      const sub = g.subgraph(agentUid, 'memories');

      // Valid data passes
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'valid' });

      // Invalid data fails
      await expect(
        sub.putNode('memory', generateId(), { text: 123 } as any),
      ).rejects.toThrow();
    });

    it('allowedIn restricts types to specific subgraph paths', async () => {
      const registry = createRegistry([
        { aType: 'agent', axbType: 'is', bType: 'agent', allowedIn: ['root'] },
        { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['memories', '**/memories'] },
      ]);
      const g = createGraphClient(db, collectionPath, { registry });

      // Agent allowed at root
      const agentUid = generateId();
      await g.putNode('agent', agentUid, {});

      // Memory not allowed at root
      await expect(
        g.putNode('memory', generateId(), {}),
      ).rejects.toThrow(RegistryScopeError);

      const sub = g.subgraph(agentUid, 'memories');

      // Memory allowed in 'memories' subgraph
      await sub.putNode('memory', generateId(), {});

      // Agent not allowed in 'memories' subgraph
      await expect(
        sub.putNode('agent', generateId(), {}),
      ).rejects.toThrow(RegistryScopeError);
    });
  });

  describe('transactions in subgraph', () => {
    it('transaction reads and writes within subgraph scope', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent' });

      const sub = g.subgraph(parentUid, 'memories');
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'original' });

      await sub.runTransaction(async (tx) => {
        const node = await tx.getNode(memUid);
        expect(node).not.toBeNull();
        expect(node!.data).toEqual({ text: 'original' });
        tx.putNode('memory', memUid, { text: 'updated' });
      });

      const updated = await sub.getNode(memUid);
      expect(updated!.data).toEqual({ text: 'updated' });
    });

    it('transaction enforces scope validation', async () => {
      const registry = createRegistry([
        { aType: 'agent', axbType: 'is', bType: 'agent', allowedIn: ['root'] },
        { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['**/memories'] },
      ]);
      const g = createGraphClient(db, collectionPath, { registry });
      const agentUid = generateId();
      await g.putNode('agent', agentUid, {});

      const sub = g.subgraph(agentUid, 'memories');

      await expect(
        sub.runTransaction(async (tx) => {
          // Agent not allowed in memories subgraph
          await tx.putNode('agent', generateId(), {});
        }),
      ).rejects.toThrow(RegistryScopeError);
    });
  });

  describe('batch in subgraph', () => {
    it('batch writes within subgraph scope', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent' });

      const sub = g.subgraph(parentUid, 'memories');
      const m1 = generateId();
      const m2 = generateId();

      const batch = sub.batch();
      await batch.putNode('memory', m1, { text: 'first' });
      await batch.putNode('memory', m2, { text: 'second' });
      await batch.commit();

      const node1 = await sub.getNode(m1);
      const node2 = await sub.getNode(m2);
      expect(node1).not.toBeNull();
      expect(node2).not.toBeNull();
    });

    it('batch enforces scope validation', async () => {
      const registry = createRegistry([
        { aType: 'agent', axbType: 'is', bType: 'agent', allowedIn: ['root'] },
        { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['**/memories'] },
      ]);
      const g = createGraphClient(db, collectionPath, { registry });
      const agentUid = generateId();
      await g.putNode('agent', agentUid, {});

      const sub = g.subgraph(agentUid, 'memories');
      const batch = sub.batch();

      // Agent not allowed in memories subgraph
      await expect(
        batch.putNode('agent', generateId(), {}),
      ).rejects.toThrow(RegistryScopeError);
    });
  });

  describe('cascade delete with subcollections', () => {
    it('removeNodeCascade deletes subgraph data recursively', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent' });

      // Create subgraph data
      const sub = g.subgraph(parentUid, 'memories');
      const m1 = generateId();
      const m2 = generateId();
      await sub.putNode('memory', m1, { text: 'first' });
      await sub.putNode('memory', m2, { text: 'second' });
      await sub.putEdge('memory', m1, 'linksTo', 'memory', m2, { weight: 1 });

      // Cascade delete the parent
      const result = await g.removeNodeCascade(parentUid);
      expect(result.nodeDeleted).toBe(true);

      // Parent should be gone
      const parentNode = await g.getNode(parentUid);
      expect(parentNode).toBeNull();

      // Subgraph data should be gone too
      const subNode1 = await sub.getNode(m1);
      const subNode2 = await sub.getNode(m2);
      expect(subNode1).toBeNull();
      expect(subNode2).toBeNull();
    });

    it('removeNodeCascade with deleteSubcollections=false preserves subgraph', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent' });

      const sub = g.subgraph(parentUid, 'memories');
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'preserved' });

      await g.removeNodeCascade(parentUid, { deleteSubcollections: false });

      // Parent should be gone
      expect(await g.getNode(parentUid)).toBeNull();

      // Subgraph data should be preserved
      const subNode = await sub.getNode(memUid);
      expect(subNode).not.toBeNull();
      expect(subNode!.data).toEqual({ text: 'preserved' });
    });
  });

  describe('subgraph name validation', () => {
    it('rejects names containing slashes', () => {
      const g = createGraphClient(db, collectionPath);
      expect(() => g.subgraph(generateId(), 'a/b')).toThrow(/must not contain/);
    });
  });

  describe('default subgraph name', () => {
    it('uses "graph" as default name', async () => {
      const g = createGraphClient(db, collectionPath);
      const parentUid = generateId();
      await g.putNode('agent', parentUid, { name: 'Agent' });

      // No name specified — defaults to 'graph'
      const sub = g.subgraph(parentUid);
      const memUid = generateId();
      await sub.putNode('memory', memUid, { text: 'test' });

      // Should be retrievable from the same default subgraph
      const sub2 = g.subgraph(parentUid);
      const node = await sub2.getNode(memUid);
      expect(node).not.toBeNull();
    });
  });
});
