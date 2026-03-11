import { describe, it, expect } from 'vitest';
import { generateIndexConfig } from '../../src/indexes.js';
import type { DiscoveryResult, DiscoveredEntity } from '../../src/types.js';

describe('generateIndexConfig', () => {
  it('generates 4 base indexes with no entities', () => {
    const config = generateIndexConfig('graph');
    expect(config.indexes).toHaveLength(4);
    expect(config.fieldOverrides).toEqual([]);

    // Verify all 4 base patterns
    const fieldPaths = config.indexes.map(
      (idx) => idx.fields.map((f) => f.fieldPath).join(', '),
    );
    expect(fieldPaths).toContain('aUid, axbType');
    expect(fieldPaths).toContain('axbType, bUid');
    expect(fieldPaths).toContain('aType, axbType');
    expect(fieldPaths).toContain('axbType, bType');
  });

  it('uses the provided collection name', () => {
    const config = generateIndexConfig('my_graph');
    for (const idx of config.indexes) {
      expect(idx.collectionGroup).toBe('my_graph');
    }
  });

  it('adds data-field indexes for node types', () => {
    const entities: DiscoveryResult = {
      nodes: new Map<string, DiscoveredEntity>([
        ['task', {
          kind: 'node',
          name: 'task',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              status: { type: 'string' },
            },
          },
        }],
      ]),
      edges: new Map(),
    };

    const config = generateIndexConfig('graph', entities);
    // 4 base + 2 data fields (title, status)
    expect(config.indexes).toHaveLength(6);

    const dataIndexes = config.indexes.filter(
      (idx) => idx.fields.some((f) => f.fieldPath.startsWith('data.')),
    );
    expect(dataIndexes).toHaveLength(2);

    // Each data index should be (aType, axbType, data.{field})
    for (const idx of dataIndexes) {
      expect(idx.fields).toHaveLength(3);
      expect(idx.fields[0].fieldPath).toBe('aType');
      expect(idx.fields[1].fieldPath).toBe('axbType');
      expect(idx.fields[2].fieldPath).toMatch(/^data\./);
    }
  });

  it('adds data-field indexes for edge types', () => {
    const entities: DiscoveryResult = {
      nodes: new Map(),
      edges: new Map<string, DiscoveredEntity>([
        ['hasStep', {
          kind: 'edge',
          name: 'hasStep',
          schema: {
            type: 'object',
            properties: {
              order: { type: 'number' },
            },
          },
          topology: { from: 'task', to: 'step' },
        }],
      ]),
    };

    const config = generateIndexConfig('graph', entities);
    // 4 base + 1 data field (order)
    expect(config.indexes).toHaveLength(5);

    const dataIndexes = config.indexes.filter(
      (idx) => idx.fields.some((f) => f.fieldPath.startsWith('data.')),
    );
    expect(dataIndexes).toHaveLength(1);

    // Edge data index should be (aUid, axbType, data.{field})
    const edgeIdx = dataIndexes[0];
    expect(edgeIdx.fields).toHaveLength(3);
    expect(edgeIdx.fields[0].fieldPath).toBe('aUid');
    expect(edgeIdx.fields[1].fieldPath).toBe('axbType');
    expect(edgeIdx.fields[2].fieldPath).toBe('data.order');
  });

  it('handles schemas without properties', () => {
    const entities: DiscoveryResult = {
      nodes: new Map<string, DiscoveredEntity>([
        ['empty', {
          kind: 'node',
          name: 'empty',
          schema: { type: 'object' },
        }],
      ]),
      edges: new Map(),
    };

    const config = generateIndexConfig('graph', entities);
    // Only 4 base indexes, no data field indexes
    expect(config.indexes).toHaveLength(4);
  });

  it('handles non-object schemas', () => {
    const entities: DiscoveryResult = {
      nodes: new Map<string, DiscoveredEntity>([
        ['weird', {
          kind: 'node',
          name: 'weird',
          schema: { type: 'string' },
        }],
      ]),
      edges: new Map(),
    };

    const config = generateIndexConfig('graph', entities);
    expect(config.indexes).toHaveLength(4);
  });

  it('all indexes have COLLECTION queryScope and ASCENDING order', () => {
    const config = generateIndexConfig('graph');
    for (const idx of config.indexes) {
      expect(idx.queryScope).toBe('COLLECTION');
      for (const field of idx.fields) {
        expect(field.order).toBe('ASCENDING');
      }
    }
  });
});
