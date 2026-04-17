import { describe, expect, it } from 'vitest';

import { generateIndexConfig } from '../../src/indexes.js';
import type { DiscoveredEntity, DiscoveryResult, RegistryEntry } from '../../src/types.js';

describe('generateIndexConfig', () => {
  it('generates 4 base indexes with no entities', () => {
    const config = generateIndexConfig('graph');
    expect(config.indexes).toHaveLength(4);
    expect(config.fieldOverrides).toEqual([]);

    // Verify all 4 base patterns
    const fieldPaths = config.indexes.map((idx) => idx.fields.map((f) => f.fieldPath).join(', '));
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
        [
          'task',
          {
            kind: 'node',
            name: 'task',
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        ],
      ]),
      edges: new Map(),
    };

    const config = generateIndexConfig('graph', entities);
    // 4 base + 2 data fields (title, status)
    expect(config.indexes).toHaveLength(6);

    const dataIndexes = config.indexes.filter((idx) =>
      idx.fields.some((f) => f.fieldPath.startsWith('data.')),
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
        [
          'hasStep',
          {
            kind: 'edge',
            name: 'hasStep',
            schema: {
              type: 'object',
              properties: {
                order: { type: 'number' },
              },
            },
            topology: { from: 'task', to: 'step' },
          },
        ],
      ]),
    };

    const config = generateIndexConfig('graph', entities);
    // 4 base + 1 data field (order)
    expect(config.indexes).toHaveLength(5);

    const dataIndexes = config.indexes.filter((idx) =>
      idx.fields.some((f) => f.fieldPath.startsWith('data.')),
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
        [
          'empty',
          {
            kind: 'node',
            name: 'empty',
            schema: { type: 'object' },
          },
        ],
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
        [
          'weird',
          {
            kind: 'node',
            name: 'weird',
            schema: { type: 'string' },
          },
        ],
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

  describe('collection group indexes', () => {
    it('generates collection group indexes when registry has targetGraph entries', () => {
      const entries: RegistryEntry[] = [
        { aType: 'task', axbType: 'is', bType: 'task' },
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      ];

      const config = generateIndexConfig('graph', undefined, entries);
      // 4 base + 4 collection group for 'workflow'
      expect(config.indexes).toHaveLength(8);

      const cgIndexes = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
      expect(cgIndexes).toHaveLength(4);

      // All collection group indexes should use the targetGraph name
      for (const idx of cgIndexes) {
        expect(idx.collectionGroup).toBe('workflow');
      }

      // Verify the 4 patterns exist
      const fieldPaths = cgIndexes.map((idx) => idx.fields.map((f) => f.fieldPath).join(', '));
      expect(fieldPaths).toContain('aUid, axbType');
      expect(fieldPaths).toContain('axbType, bUid');
      expect(fieldPaths).toContain('aType, axbType');
      expect(fieldPaths).toContain('axbType, bType');
    });

    it('deduplicates collection group indexes per targetGraph name', () => {
      const entries: RegistryEntry[] = [
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
        { aType: 'task', axbType: 'ownedBy', bType: 'user', targetGraph: 'workflow' },
      ];

      const config = generateIndexConfig('graph', undefined, entries);
      const cgIndexes = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
      // Only 4 (not 8), because both edges share the same targetGraph name
      expect(cgIndexes).toHaveLength(4);
    });

    it('generates separate collection group indexes for distinct targetGraph names', () => {
      const entries: RegistryEntry[] = [
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
        {
          aType: 'project',
          axbType: 'hasMilestone',
          bType: 'milestone',
          targetGraph: 'milestones',
        },
      ];

      const config = generateIndexConfig('graph', undefined, entries);
      const cgIndexes = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
      // 4 for 'workflow' + 4 for 'milestones'
      expect(cgIndexes).toHaveLength(8);

      const workflowIndexes = cgIndexes.filter((idx) => idx.collectionGroup === 'workflow');
      const milestoneIndexes = cgIndexes.filter((idx) => idx.collectionGroup === 'milestones');
      expect(workflowIndexes).toHaveLength(4);
      expect(milestoneIndexes).toHaveLength(4);
    });

    it('skips collection group indexes when no registry entries provided', () => {
      const config = generateIndexConfig('graph');
      const cgIndexes = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
      expect(cgIndexes).toHaveLength(0);
    });

    it('skips collection group indexes when no entries have targetGraph', () => {
      const entries: RegistryEntry[] = [
        { aType: 'task', axbType: 'is', bType: 'task' },
        { aType: 'task', axbType: 'hasStep', bType: 'step' },
      ];

      const config = generateIndexConfig('graph', undefined, entries);
      const cgIndexes = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
      expect(cgIndexes).toHaveLength(0);
    });

    it('combines entity data indexes with collection group indexes', () => {
      const entities: DiscoveryResult = {
        nodes: new Map<string, DiscoveredEntity>([
          [
            'task',
            {
              kind: 'node',
              name: 'task',
              schema: {
                type: 'object',
                properties: { title: { type: 'string' } },
              },
            },
          ],
        ]),
        edges: new Map(),
      };

      const entries: RegistryEntry[] = [
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      ];

      const config = generateIndexConfig('graph', entities, entries);
      // 4 base + 1 data field (title) + 4 collection group
      expect(config.indexes).toHaveLength(9);
    });
  });
});
