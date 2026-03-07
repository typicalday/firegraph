import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import {
  RegistryViolationError,
  ValidationError,
  DynamicRegistryError,
} from '../../src/errors.js';
import { META_NODE_TYPE, META_EDGE_TYPE } from '../../src/dynamic-registry.js';
import type { DynamicGraphClient } from '../../src/types.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};

const edgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'number' } },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Full agent workflow
// ---------------------------------------------------------------------------

describe('dynamic registry — full workflow', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath(), {
      registryMode: { mode: 'dynamic' },
    });
  });

  it('defineNodeType → reloadRegistry → putNode succeeds', async () => {
    await g.defineNodeType('tour', tourSchema, 'A guided tour');
    await g.reloadRegistry();

    await g.putNode('tour', 'tour1', { name: 'Dolomites' });
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Dolomites');
  });

  it('defineEdgeType → reloadRegistry → putEdge succeeds', async () => {
    // Define both node types and the edge type
    await g.defineNodeType('tour', tourSchema);
    await g.defineNodeType('departure', {
      type: 'object',
      properties: { date: { type: 'string' } },
    });
    await g.defineEdgeType(
      'hasDeparture',
      { from: 'tour', to: 'departure', inverseLabel: 'departureOf' },
      edgeSchema,
      'Tours have departures',
    );
    await g.reloadRegistry();

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(edge).not.toBeNull();
    expect(edge!.data.order).toBe(0);
  });

  it('domain write before reloadRegistry is rejected', async () => {
    await g.defineNodeType('tour', tourSchema);
    // Don't reload — dynamic registry is not compiled yet

    await expect(
      g.putNode('tour', 'tour1', { name: 'X' }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('meta-type write without reload succeeds (bootstrap validates)', async () => {
    // Meta-type writes are always validated by the bootstrap registry
    await g.defineNodeType('tour', tourSchema);

    // Verify it was written by reading it back as a node
    const records = await g.findNodes({ aType: META_NODE_TYPE });
    expect(records.length).toBeGreaterThanOrEqual(1);
    const tourTypeDef = records.find((r) => r.data.name === 'tour');
    expect(tourTypeDef).toBeDefined();
  });

  it('rejects invalid meta-type data (bad nodeType)', async () => {
    // name is required
    await expect(
      g.putNode(META_NODE_TYPE, 'bad-uid', { jsonSchema: { type: 'object' } }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects invalid meta-type data (bad edgeType)', async () => {
    // from and to are required
    await expect(
      g.putNode(META_EDGE_TYPE, 'bad-uid', { name: 'missingFields' }),
    ).rejects.toThrow(ValidationError);
  });

  it('validates domain data after reload', async () => {
    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();

    // Valid data
    await g.putNode('tour', 'tour1', { name: 'Dolomites' });

    // Invalid data — name must be a string
    await expect(
      g.putNode('tour', 'tour2', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects unregistered domain types after reload', async () => {
    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();

    // 'booking' was never defined
    await expect(
      g.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('validates edge data after reload', async () => {
    await g.defineNodeType('tour', tourSchema);
    await g.defineEdgeType(
      'hasDeparture',
      { from: 'tour', to: 'departure' },
      edgeSchema,
    );
    await g.reloadRegistry();

    // Valid
    await g.putEdge('tour', 't1', 'hasDeparture', 'departure', 'd1', { order: 0 });

    // Invalid — order must be number
    await expect(
      g.putEdge('tour', 't1', 'hasDeparture', 'departure', 'd2', {
        order: 'bad' as unknown as number,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('can query domain nodes after define + reload + write', async () => {
    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();

    await g.putNode('tour', 'tour1', { name: 'A' });
    await g.putNode('tour', 'tour2', { name: 'B' });

    const nodes = await g.findNodes({ aType: 'tour' });
    expect(nodes).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Upsert semantics
// ---------------------------------------------------------------------------

describe('dynamic registry — upsert', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath(), {
      registryMode: { mode: 'dynamic' },
    });
  });

  it('defineNodeType twice with different schemas uses the latest', async () => {
    // First definition: name required
    await g.defineNodeType('tour', {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });

    // Second definition: title required instead
    await g.defineNodeType('tour', {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' } },
      additionalProperties: false,
    });

    await g.reloadRegistry();

    // { title } is valid under new schema
    await g.putNode('tour', 'tour1', { title: 'X' });

    // { name } is NOT valid under new schema
    await expect(
      g.putNode('tour', 'tour2', { name: 'Y' }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Reserved names
// ---------------------------------------------------------------------------

describe('dynamic registry — reserved names', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath(), {
      registryMode: { mode: 'dynamic' },
    });
  });

  it('defineNodeType("nodeType") throws DynamicRegistryError', async () => {
    await expect(
      g.defineNodeType('nodeType', { type: 'object' }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineNodeType("edgeType") throws DynamicRegistryError', async () => {
    await expect(
      g.defineNodeType('edgeType', { type: 'object' }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineEdgeType("nodeType") throws DynamicRegistryError', async () => {
    await expect(
      g.defineEdgeType('nodeType', { from: 'a', to: 'b' }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineEdgeType("edgeType") throws DynamicRegistryError', async () => {
    await expect(
      g.defineEdgeType('edgeType', { from: 'a', to: 'b' }),
    ).rejects.toThrow(DynamicRegistryError);
  });
});

// ---------------------------------------------------------------------------
// Separate meta-collection
// ---------------------------------------------------------------------------

describe('dynamic registry — separate collection', () => {
  const db = getTestFirestore();

  it('writes meta-nodes to separate collection and domain data to main', async () => {
    const mainPath = uniqueCollectionPath();
    const metaPath = uniqueCollectionPath();

    const g = createGraphClient(db, mainPath, {
      registryMode: { mode: 'dynamic', collection: metaPath },
    });

    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();
    await g.putNode('tour', 'tour1', { name: 'X' });

    // Domain data in main collection
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();

    // Meta-nodes are NOT in main collection
    const metaInMain = await g.findNodes({ aType: META_NODE_TYPE });
    expect(metaInMain).toHaveLength(0);

    // Verify meta-nodes are in separate collection by creating a reader for it
    const metaReader = createGraphClient(db, metaPath);
    const metaNodes = await metaReader.findNodes({ aType: META_NODE_TYPE });
    expect(metaNodes.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('dynamic registry — transactions', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(async () => {
    g = createGraphClient(db, uniqueCollectionPath(), {
      registryMode: { mode: 'dynamic' },
    });
    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();
  });

  it('transaction can write registered domain types', async () => {
    await g.runTransaction(async (tx) => {
      await tx.putNode('tour', 'tour1', { name: 'TransactionTour' });
    });

    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('TransactionTour');
  });

  it('transaction rejects unregistered domain types', async () => {
    await expect(
      g.runTransaction(async (tx) => {
        await tx.putNode('booking', 'b1', { total: 500 });
      }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('transaction validates data against schema', async () => {
    await expect(
      g.runTransaction(async (tx) => {
        await tx.putNode('tour', 'tour1', { name: 123 as unknown as string });
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe('dynamic registry — batches', () => {
  const db = getTestFirestore();
  let g: DynamicGraphClient;

  beforeEach(async () => {
    g = createGraphClient(db, uniqueCollectionPath(), {
      registryMode: { mode: 'dynamic' },
    });
    await g.defineNodeType('tour', tourSchema);
    await g.reloadRegistry();
  });

  it('batch can write registered domain types', async () => {
    const batch = g.batch();
    await batch.putNode('tour', 'tour1', { name: 'BatchTour' });
    await batch.commit();

    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
  });

  it('batch rejects unregistered domain types', async () => {
    const batch = g.batch();
    await expect(
      batch.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusivity
// ---------------------------------------------------------------------------

describe('dynamic registry — mutual exclusivity', () => {
  const db = getTestFirestore();

  it('throws DynamicRegistryError when both registry and registryMode are provided', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);

    expect(() =>
      createGraphClient(db, uniqueCollectionPath(), {
        registry,
        registryMode: { mode: 'dynamic' },
      }),
    ).toThrow(DynamicRegistryError);
  });

  it('static registry mode works unchanged', async () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const g = createGraphClient(db, uniqueCollectionPath(), { registry });

    await g.putNode('tour', 'tour1', { name: 'X' });
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();

    await expect(
      g.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('no registry mode works unchanged (no validation)', async () => {
    const g = createGraphClient(db, uniqueCollectionPath());

    await g.putNode('anything', 'id1', { whatever: true });
    const node = await g.getNode('id1');
    expect(node).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dynamic methods unavailable in static mode
// ---------------------------------------------------------------------------

describe('dynamic registry — methods unavailable in static mode', () => {
  const db = getTestFirestore();

  it('defineNodeType throws on static client', async () => {
    const g = createGraphClient(db, uniqueCollectionPath());

    // We need to cast because TypeScript won't expose these methods
    // on a non-dynamic client, but we test runtime safety
    const dynamic = g as unknown as DynamicGraphClient;
    await expect(
      dynamic.defineNodeType('tour', tourSchema),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('defineEdgeType throws on static client', async () => {
    const g = createGraphClient(db, uniqueCollectionPath());
    const dynamic = g as unknown as DynamicGraphClient;
    await expect(
      dynamic.defineEdgeType('rel', { from: 'a', to: 'b' }),
    ).rejects.toThrow(DynamicRegistryError);
  });

  it('reloadRegistry throws on static client', async () => {
    const g = createGraphClient(db, uniqueCollectionPath());
    const dynamic = g as unknown as DynamicGraphClient;
    await expect(dynamic.reloadRegistry()).rejects.toThrow(DynamicRegistryError);
  });
});
