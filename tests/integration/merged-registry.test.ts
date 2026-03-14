import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import {
  DynamicRegistryError,
  RegistryViolationError,
  ValidationError,
} from '../../src/errors.js';
import type { DynamicGraphClient } from '../../src/types.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};

const departureSchema = {
  type: 'object',
  required: ['date'],
  properties: { date: { type: 'string' } },
  additionalProperties: false,
};

const edgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'number' } },
  additionalProperties: false,
};

const milestoneSchema = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Merged mode: static + dynamic
// ---------------------------------------------------------------------------

describe('merged registry — basic workflow', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(() => {
    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'departure', axbType: 'is', bType: 'departure', jsonSchema: departureSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);

    g = createGraphClient(db, uniqueCollectionPath(), {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic' },
    });
  });

  it('static types are immediately usable without reloadRegistry', async () => {
    // Static entries should work before any dynamic reload
    await g.putNode('tour', 'tour1', { name: 'Dolomites' });
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Dolomites');
  });

  it('static types validate data correctly', async () => {
    await expect(
      g.putNode('tour', 'tour1', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);
  });

  it('unregistered types are rejected before reload', async () => {
    await expect(
      g.putNode('milestone', 'm1', { title: 'v1.0' }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('dynamic types work after defineNodeType + reloadRegistry', async () => {
    await g.defineNodeType('milestone', milestoneSchema, 'A project milestone');
    await g.reloadRegistry();

    await g.putNode('milestone', 'm1', { title: 'v1.0' });
    const node = await g.getNode('m1');
    expect(node).not.toBeNull();
    expect(node!.data.title).toBe('v1.0');
  });

  it('static types still work after reloadRegistry', async () => {
    await g.defineNodeType('milestone', milestoneSchema);
    await g.reloadRegistry();

    // Static types are still available and validated correctly
    await g.putNode('tour', 'tour1', { name: 'Alps' });
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Alps');

    // Static validation still enforced
    await expect(
      g.putNode('tour', 'tour2', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);
  });

  it('static edge types work in merged mode', async () => {
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 1 });
    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(edge).not.toBeNull();
    expect(edge!.data.order).toBe(1);
  });

  it('dynamic edge types work after definition', async () => {
    await g.defineNodeType('milestone', milestoneSchema);
    await g.defineEdgeType(
      'hasMilestone',
      { from: 'tour', to: 'milestone', inverseLabel: 'milestoneOf' },
      { type: 'object', properties: { priority: { type: 'number' } } },
    );
    await g.reloadRegistry();

    await g.putEdge('tour', 'tour1', 'hasMilestone', 'milestone', 'm1', { priority: 1 });
    const edge = await g.getEdge('tour1', 'hasMilestone', 'm1');
    expect(edge).not.toBeNull();
    expect(edge!.data.priority).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Override protection
// ---------------------------------------------------------------------------

describe('merged registry — override protection', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(() => {
    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);

    g = createGraphClient(db, uniqueCollectionPath(), {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic' },
    });
  });

  it('defineNodeType rejects types already in static registry', async () => {
    await expect(
      g.defineNodeType('tour', { type: 'object', properties: { title: { type: 'string' } } }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineNodeType rejects with descriptive message', async () => {
    await expect(
      g.defineNodeType('tour', { type: 'object' }),
    ).rejects.toThrow(/already defined in the static registry/);
  });

  it('defineEdgeType rejects edges already in static registry', async () => {
    await expect(
      g.defineEdgeType('hasDeparture', { from: 'tour', to: 'departure' }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineEdgeType rejects with descriptive message', async () => {
    await expect(
      g.defineEdgeType('hasDeparture', { from: 'tour', to: 'departure' }),
    ).rejects.toThrow(/already defined in the static registry/);
  });

  it('defineNodeType allows types not in static registry', async () => {
    // Should not throw — milestone is not in the static registry
    await g.defineNodeType('milestone', milestoneSchema);
  });

  it('defineEdgeType allows edges not in static registry', async () => {
    await g.defineEdgeType('hasMilestone', { from: 'tour', to: 'milestone' });
  });

  it('defineEdgeType checks all from/to combinations against static', async () => {
    // tour -> departure is in static, so this should be rejected even though
    // trek -> departure is not
    await expect(
      g.defineEdgeType('hasDeparture', { from: ['tour', 'trek'], to: 'departure' }),
    ).rejects.toThrow(DynamicRegistryError);
  });
});

// ---------------------------------------------------------------------------
// Transactions and batches
// ---------------------------------------------------------------------------

describe('merged registry — transactions', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(async () => {
    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);

    g = createGraphClient(db, uniqueCollectionPath(), {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic' },
    });

    await g.defineNodeType('milestone', milestoneSchema);
    await g.reloadRegistry();
  });

  it('transaction can write both static and dynamic types', async () => {
    await g.runTransaction(async (tx) => {
      await tx.putNode('tour', 'tour1', { name: 'TransactionTour' });
      await tx.putNode('milestone', 'm1', { title: 'v1.0' });
    });

    const tour = await g.getNode('tour1');
    expect(tour).not.toBeNull();
    expect(tour!.data.name).toBe('TransactionTour');

    const milestone = await g.getNode('m1');
    expect(milestone).not.toBeNull();
    expect(milestone!.data.title).toBe('v1.0');
  });

  it('transaction rejects unregistered types', async () => {
    await expect(
      g.runTransaction(async (tx) => {
        await tx.putNode('booking', 'b1', { total: 500 });
      }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('transaction validates data against correct schema', async () => {
    // Static type with wrong data
    await expect(
      g.runTransaction(async (tx) => {
        await tx.putNode('tour', 'tour1', { name: 123 as unknown as string });
      }),
    ).rejects.toThrow(ValidationError);

    // Dynamic type with wrong data
    await expect(
      g.runTransaction(async (tx) => {
        await tx.putNode('milestone', 'm1', { title: 123 as unknown as string });
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('merged registry — batches', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(async () => {
    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);

    g = createGraphClient(db, uniqueCollectionPath(), {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic' },
    });

    await g.defineNodeType('milestone', milestoneSchema);
    await g.reloadRegistry();
  });

  it('batch can write both static and dynamic types', async () => {
    const batch = g.batch();
    await batch.putNode('tour', 'tour1', { name: 'BatchTour' });
    await batch.putNode('milestone', 'm1', { title: 'v1.0' });
    await batch.commit();

    const tour = await g.getNode('tour1');
    expect(tour).not.toBeNull();

    const milestone = await g.getNode('m1');
    expect(milestone).not.toBeNull();
  });

  it('batch rejects unregistered types', async () => {
    const batch = g.batch();
    await expect(
      batch.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);
  });
});

// ---------------------------------------------------------------------------
// Separate meta-collection in merged mode
// ---------------------------------------------------------------------------

describe('merged registry — separate meta-collection', () => {
  const db = getTestFirestore();

  it('meta-nodes go to meta-collection, domain data uses main', async () => {
    const mainPath = uniqueCollectionPath();
    const metaPath = uniqueCollectionPath();

    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);

    const g = createGraphClient(db, mainPath, {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic', collection: metaPath },
    });

    await g.defineNodeType('milestone', milestoneSchema);
    await g.reloadRegistry();

    await g.putNode('tour', 'tour1', { name: 'Static' });
    await g.putNode('milestone', 'm1', { title: 'Dynamic' });

    const tour = await g.getNode('tour1');
    expect(tour).not.toBeNull();

    const milestone = await g.getNode('m1');
    expect(milestone).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Subgraph behavior in merged mode
// ---------------------------------------------------------------------------

describe('merged registry — subgraph', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(async () => {
    const staticRegistry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);

    g = createGraphClient(db, uniqueCollectionPath(), {
      registry: staticRegistry,
      registryMode: { mode: 'dynamic' },
    });

    await g.defineNodeType('milestone', milestoneSchema);
    await g.reloadRegistry();
  });

  it('subgraph client inherits merged registry and can write both types', async () => {
    // Create a parent node first
    await g.putNode('tour', 'tour1', { name: 'Parent' });

    const sub = g.subgraph('tour1', 'details');

    // Static type in subgraph
    await sub.putNode('tour', 'sub-tour1', { name: 'SubTour' });
    const tourNode = await sub.getNode('sub-tour1');
    expect(tourNode).not.toBeNull();
    expect(tourNode!.data.name).toBe('SubTour');

    // Dynamic type in subgraph
    await sub.putNode('milestone', 'sub-m1', { title: 'SubMilestone' });
    const milestoneNode = await sub.getNode('sub-m1');
    expect(milestoneNode).not.toBeNull();
    expect(milestoneNode!.data.title).toBe('SubMilestone');
  });

  it('subgraph client rejects unregistered types', async () => {
    await g.putNode('tour', 'tour1', { name: 'Parent' });
    const sub = g.subgraph('tour1');

    await expect(
      sub.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('subgraph client validates against correct schema', async () => {
    await g.putNode('tour', 'tour1', { name: 'Parent' });
    const sub = g.subgraph('tour1');

    // Static type validation
    await expect(
      sub.putNode('tour', 'sub-t1', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);

    // Dynamic type validation
    await expect(
      sub.putNode('milestone', 'sub-m1', { title: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Dynamic methods still gated properly
// ---------------------------------------------------------------------------

describe('merged registry — dynamic methods only in dynamic mode', () => {
  const db = getTestFirestore();

  it('static-only client still rejects defineNodeType', async () => {
    const g = createGraphClient(db, uniqueCollectionPath(), {
      registry: createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
      ]),
    });

    const dynamic = g as unknown as DynamicGraphClient;
    await expect(
      dynamic.defineNodeType('milestone', milestoneSchema),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('static-only client still rejects reloadRegistry', async () => {
    const g = createGraphClient(db, uniqueCollectionPath(), {
      registry: createRegistry([
        { aType: 'tour', axbType: 'is', bType: 'tour' },
      ]),
    });

    const dynamic = g as unknown as DynamicGraphClient;
    await expect(dynamic.reloadRegistry()).rejects.toThrow(DynamicRegistryError);
  });
});
