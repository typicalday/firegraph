import { describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/firestore.js';
import { generateId } from '../../src/id.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

// ---------------------------------------------------------------------------
// Dynamic registry migration — end-to-end
// ---------------------------------------------------------------------------

describe('migration — dynamic registry', () => {
  const db = getTestFirestore();

  it('workflow: define with migrations → reload → read triggers migration', async () => {
    const collPath = uniqueCollectionPath();
    const dynamicClient = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
    });

    // Write legacy v0 data using a bare (no-registry) client
    const bareClient = createGraphClient(db, collPath);
    const tourUid = generateId();
    await bareClient.putNode('tour', tourUid, { title: 'Legacy Tour' });

    // Define type with migrations
    await dynamicClient.defineNodeType(
      'tour',
      {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          status: { type: 'string' },
        },
        additionalProperties: false,
      },
      'A tour entity',
      {
        migrations: [
          { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, status: d.status || "draft" })' },
        ],
      },
    );

    await dynamicClient.reloadRegistry();

    // Read should trigger migration
    const node = await dynamicClient.getNode(tourUid);
    expect(node).not.toBeNull();
    expect(node!.v).toBe(1);
    expect(node!.data.status).toBe('draft');
    expect(node!.data.title).toBe('Legacy Tour');
  });

  it('stamps v on putNode after reload', async () => {
    const collPath = uniqueCollectionPath();
    const client = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
    });

    await client.defineNodeType(
      'task',
      {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          done: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      'A task',
      {
        migrations: [{ fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, done: false })' }],
      },
    );

    await client.reloadRegistry();

    const uid = generateId();
    await client.putNode('task', uid, { name: 'Do it', done: true });

    const node = await client.getNode(uid);
    expect(node).not.toBeNull();
    expect(node!.v).toBe(1);
    expect(node!.data.name).toBe('Do it');
  });

  it('compiles stored migration functions via sandbox', async () => {
    const collPath = uniqueCollectionPath();
    const client = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
    });

    // Multi-step migration stored as strings
    await client.defineNodeType(
      'doc',
      {
        type: 'object',
        properties: {
          title: { type: 'string' },
          archived: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      'A document',
      {
        migrations: [
          { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, archived: false })' },
          { fromVersion: 1, toVersion: 2, up: '(d) => ({ ...d, tags: [] })' },
        ],
      },
    );

    await client.reloadRegistry();

    // Write legacy data via bare client
    const bare = createGraphClient(db, collPath);
    const uid = generateId();
    await bare.putNode('doc', uid, { title: 'Hello' });

    // Read with dynamic client should apply both migrations
    const node = await client.getNode(uid);
    expect(node).not.toBeNull();
    expect(node!.v).toBe(2);
    expect(node!.data.archived).toBe(false);
    expect(node!.data.tags).toEqual([]);
    expect(node!.data.title).toBe('Hello');
  });

  it('uses custom migrationSandbox executor', async () => {
    let executorCallCount = 0;

    const collPath = uniqueCollectionPath();
    const client = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
      migrationSandbox: (source: string) => {
        executorCallCount++;

        return new Function('return ' + source)() as (
          d: Record<string, unknown>,
        ) => Record<string, unknown>;
      },
    });

    await client.defineNodeType(
      'item',
      {
        type: 'object',
        properties: {
          label: { type: 'string' },
          rank: { type: 'number' },
        },
        additionalProperties: false,
      },
      'An item',
      {
        migrations: [{ fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, rank: 0 })' }],
      },
    );

    await client.reloadRegistry();
    expect(executorCallCount).toBeGreaterThan(0);

    // Write legacy, read migrated
    const bare = createGraphClient(db, collPath);
    const uid = generateId();
    await bare.putNode('item', uid, { label: 'Test' });

    const node = await client.getNode(uid);
    expect(node!.data.rank).toBe(0);
    expect(node!.v).toBe(1);
  });

  it('supports function serialization via .toString()', async () => {
    const collPath = uniqueCollectionPath();
    const client = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
    });

    // Pass actual function objects — they should be serialized via .toString()
    await client.defineNodeType(
      'note',
      {
        type: 'object',
        properties: {
          text: { type: 'string' },
          pinned: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      'A note',
      {
        migrations: [
          {
            fromVersion: 0,
            toVersion: 1,
            up: (d: Record<string, unknown>) => ({ ...d, pinned: false }),
          },
        ],
      },
    );

    await client.reloadRegistry();

    const bare = createGraphClient(db, collPath);
    const uid = generateId();
    await bare.putNode('note', uid, { text: 'Hello' });

    const node = await client.getNode(uid);
    expect(node!.v).toBe(1);
    expect(node!.data.pinned).toBe(false);
  });

  it('supports edge type migrations', async () => {
    const collPath = uniqueCollectionPath();
    const client = createGraphClient(db, collPath, {
      registryMode: { mode: 'dynamic' },
    });

    await client.defineNodeType('project', {
      type: 'object',
      properties: { name: { type: 'string' } },
    });

    await client.defineNodeType('task', {
      type: 'object',
      properties: { title: { type: 'string' } },
    });

    await client.defineEdgeType(
      'hasTask',
      { from: 'project', to: 'task' },
      {
        type: 'object',
        properties: {
          priority: { type: 'string' },
        },
        additionalProperties: false,
      },
      'Project has tasks',
      {
        migrations: [{ fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, priority: "normal" })' }],
      },
    );

    await client.reloadRegistry();

    // Write legacy edge data
    const bare = createGraphClient(db, collPath);
    const pUid = generateId();
    const tUid = generateId();
    await bare.putNode('project', pUid, { name: 'P1' });
    await bare.putNode('task', tUid, { title: 'T1' });
    await bare.putEdge('project', pUid, 'hasTask', 'task', tUid, {});

    // Read with dynamic client should migrate edge
    const edge = await client.getEdge(pUid, 'hasTask', tUid);
    expect(edge).not.toBeNull();
    expect(edge!.v).toBe(1);
    expect(edge!.data.priority).toBe('normal');
  });
});
