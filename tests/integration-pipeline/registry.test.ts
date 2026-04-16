/**
 * Pipeline Integration — Registry Validation Tests
 *
 * Validates that schema validation via the registry works correctly
 * when the client is in pipeline mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RegistryViolationError, ValidationError } from '../../src/errors.js';
import { createGraphClient } from '../../src/firestore.js';
import { createRegistry } from '../../src/registry.js';
import type { GraphClient } from '../../src/types.js';
import { cleanupCollection, getFirestore, uniqueCollectionPath } from './setup.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    difficulty: { type: 'string' },
  },
};

const edgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'number' } },
};

describe('pipeline client with registry', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(() => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);
    g = createGraphClient(getFirestore(), collPath, {
      queryMode: 'pipeline',
      registry,
    });
  });

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('allows putNode with registered triple and valid data', async () => {
    await g.putNode('tour', 'reg-tour1', { name: 'Dolomites' });
    const node = await g.getNode('reg-tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Dolomites');
  }, 15_000);

  it('throws RegistryViolationError for unregistered triple and does NOT write', async () => {
    await expect(g.putNode('booking', 'reg-b1', { total: 500 })).rejects.toThrow(
      RegistryViolationError,
    );

    const node = await g.getNode('reg-b1');
    expect(node).toBeNull();
  });

  it('throws ValidationError for invalid data and does NOT write', async () => {
    await expect(
      g.putNode('tour', 'reg-tour2', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);

    const node = await g.getNode('reg-tour2');
    expect(node).toBeNull();
  });

  it('allows putEdge with registered triple and valid data', async () => {
    await g.putEdge('tour', 'reg-tour1', 'hasDeparture', 'departure', 'reg-dep1', { order: 0 });
    const edge = await g.getEdge('reg-tour1', 'hasDeparture', 'reg-dep1');
    expect(edge).not.toBeNull();
  });

  it('rejects putEdge with unregistered triple', async () => {
    await expect(
      g.putEdge('tour', 'reg-tour1', 'unknownRelation', 'departure', 'reg-dep2', { order: 0 }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('rejects putEdge with invalid data', async () => {
    await expect(
      g.putEdge('tour', 'reg-tour1', 'hasDeparture', 'departure', 'reg-dep3', {
        order: 'not-a-number' as unknown as number,
      }),
    ).rejects.toThrow(ValidationError);

    const edge = await g.getEdge('reg-tour1', 'hasDeparture', 'reg-dep3');
    expect(edge).toBeNull();
  });

  it('validated nodes are queryable via pipeline', async () => {
    await g.putNode('tour', 'reg-tour3', { name: 'Alps Easy' });

    const results = await g.findNodes({ aType: 'tour' });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.aUid === 'reg-tour3')).toBe(true);
  });
});

describe('pipeline client without registry', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(() => {
    g = createGraphClient(getFirestore(), collPath, { queryMode: 'pipeline' });
  });

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('accepts any triple without validation', async () => {
    await g.putNode('anything', 'noreg1', { whatever: true });
    const node = await g.getNode('noreg1');
    expect(node).not.toBeNull();
    expect(node!.data.whatever).toBe(true);
  });

  it('accepts any edge type without validation', async () => {
    await g.putEdge('x', 'noreg-a', 'randomRelation', 'y', 'noreg-b', { foo: 'bar' });
    const edge = await g.getEdge('noreg-a', 'randomRelation', 'noreg-b');
    expect(edge).not.toBeNull();
  });
});
