import { describe, it, expect, beforeEach } from 'vitest';
import { createGraphClient } from '../../src/client.js';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError, ValidationError } from '../../src/errors.js';
import { getTestFirestore, uniqueCollectionPath } from './setup.js';

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

describe('client with registry', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);
    g = createGraphClient(db, uniqueCollectionPath(), { registry });
  });

  it('allows putNode with registered triple and valid data', async () => {
    await g.putNode('tour', 'tour1', { name: 'Dolomites' });
    const node = await g.getNode('tour1');
    expect(node).not.toBeNull();
    expect(node!.data.name).toBe('Dolomites');
  });

  it('throws RegistryViolationError for unregistered triple and does NOT write', async () => {
    await expect(
      g.putNode('booking', 'b1', { total: 500 }),
    ).rejects.toThrow(RegistryViolationError);

    const node = await g.getNode('b1');
    expect(node).toBeNull();
  });

  it('throws ValidationError for invalid data and does NOT write', async () => {
    await expect(
      g.putNode('tour', 'tour1', { name: 123 as unknown as string }),
    ).rejects.toThrow(ValidationError);

    const node = await g.getNode('tour1');
    expect(node).toBeNull();
  });

  it('allows putEdge with registered triple and valid data', async () => {
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(edge).not.toBeNull();
  });

  it('rejects putEdge with unregistered triple', async () => {
    await expect(
      g.putEdge('tour', 'tour1', 'unknownRelation', 'departure', 'dep1', { order: 0 }),
    ).rejects.toThrow(RegistryViolationError);
  });

  it('rejects putEdge with invalid data', async () => {
    await expect(
      g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 'not-a-number' as unknown as number }),
    ).rejects.toThrow(ValidationError);

    const edge = await g.getEdge('tour1', 'hasDeparture', 'dep1');
    expect(edge).toBeNull();
  });
});

describe('client without registry', () => {
  const db = getTestFirestore();
  let g: ReturnType<typeof createGraphClient>;

  beforeEach(() => {
    g = createGraphClient(db, uniqueCollectionPath());
  });

  it('accepts any triple without validation', async () => {
    await g.putNode('anything', 'id1', { whatever: true });
    const node = await g.getNode('id1');
    expect(node).not.toBeNull();
    expect(node!.data.whatever).toBe(true);
  });

  it('accepts any edge type without validation', async () => {
    await g.putEdge('x', 'a', 'randomRelation', 'y', 'b', { foo: 'bar' });
    const edge = await g.getEdge('a', 'randomRelation', 'b');
    expect(edge).not.toBeNull();
  });
});
