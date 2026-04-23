/**
 * Firestore index generator unit tests.
 *
 * `generateIndexConfig` translates firegraph's declarative `IndexSpec[]` into
 * the `firestore.indexes.json` shape consumed by
 * `firebase deploy --only firestore:indexes`.
 *
 * Rules under test:
 *   1. Default core preset produces composite indexes (single-field specs are
 *      dropped — Firestore auto-indexes every field).
 *   2. `coreIndexes` option replaces the built-in preset.
 *   3. `registryEntries[].indexes` are merged with the core preset and
 *      deduplicated by canonical fingerprint.
 *   4. Specs with `where` are dropped with a one-time warning.
 *   5. When a registry entry has `targetGraph`, every composite is mirrored as
 *      a `COLLECTION_GROUP` index under the targetGraph segment name.
 *   6. `DiscoveryResult.edges[].targetGraph` alone is enough to trigger CG
 *      mirrors (even without built registry entries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CORE_INDEXES } from '../../src/default-indexes.js';
import { _resetIndexGenWarningsForTest, generateIndexConfig } from '../../src/indexes.js';
import type {
  DiscoveredEntity,
  DiscoveryResult,
  IndexSpec,
  RegistryEntry,
} from '../../src/types.js';

function fieldPaths(idx: { fields: { fieldPath: string }[] }): string {
  return idx.fields.map((f) => f.fieldPath).join(', ');
}

describe('generateIndexConfig — default preset', () => {
  it('emits 4 composites from DEFAULT_CORE_INDEXES (single-field specs dropped)', () => {
    const config = generateIndexConfig('graph');
    // DEFAULT_CORE_INDEXES has 8 specs: 4 single-field + 4 composite.
    // Firestore auto-indexes single fields, so the generator drops them and
    // emits only the 4 composites.
    expect(config.indexes).toHaveLength(4);
    expect(config.fieldOverrides).toEqual([]);

    const paths = config.indexes.map(fieldPaths);
    expect(paths).toContain('aUid, axbType');
    expect(paths).toContain('axbType, bUid');
    expect(paths).toContain('aType, axbType');
    expect(paths).toContain('axbType, bType');
  });

  it('uses the provided collection name for every emitted index', () => {
    const config = generateIndexConfig('my_graph');
    for (const idx of config.indexes) {
      expect(idx.collectionGroup).toBe('my_graph');
      expect(idx.queryScope).toBe('COLLECTION');
    }
  });

  it('emits ASCENDING order for plain string fields', () => {
    const config = generateIndexConfig('graph');
    for (const idx of config.indexes) {
      for (const field of idx.fields) {
        expect(field.order).toBe('ASCENDING');
      }
    }
  });
});

describe('generateIndexConfig — coreIndexes override', () => {
  it('replaces the built-in preset with a custom list', () => {
    const custom: IndexSpec[] = [
      { fields: ['aType', 'axbType', 'createdAt'] },
      { fields: ['aUid', 'axbType', { path: 'updatedAt', desc: true }] },
    ];
    const config = generateIndexConfig('graph', { coreIndexes: custom });
    expect(config.indexes).toHaveLength(2);

    const paths = config.indexes.map(fieldPaths);
    expect(paths).toContain('aType, axbType, createdAt');
    expect(paths).toContain('aUid, axbType, updatedAt');

    const desc = config.indexes
      .flatMap((idx) => idx.fields)
      .filter((f) => f.order === 'DESCENDING')
      .map((f) => f.fieldPath);
    expect(desc).toEqual(['updatedAt']);
  });

  it('emits nothing when coreIndexes is empty and no registry entries supplied', () => {
    const config = generateIndexConfig('graph', { coreIndexes: [] });
    expect(config.indexes).toEqual([]);
  });

  it('drops single-field coreIndexes (Firestore auto-indexes them)', () => {
    const config = generateIndexConfig('graph', {
      coreIndexes: [{ fields: ['aType'] }, { fields: ['bUid'] }],
    });
    expect(config.indexes).toHaveLength(0);
  });
});

describe('generateIndexConfig — registry entries', () => {
  it('adds composite indexes declared on RegistryEntry.indexes', () => {
    const entries: RegistryEntry[] = [
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // 4 default composites + 1 registry composite
    expect(config.indexes).toHaveLength(5);

    const dataIndexes = config.indexes.filter((idx) =>
      idx.fields.some((f) => f.fieldPath.startsWith('data.')),
    );
    expect(dataIndexes).toHaveLength(1);
    expect(fieldPaths(dataIndexes[0])).toBe('aType, axbType, data.status');
  });

  it('drops single-field registry indexes', () => {
    const entries: RegistryEntry[] = [
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['data.status'] }],
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // Only 4 default composites — the single-field data index is dropped.
    expect(config.indexes).toHaveLength(4);
  });

  it('deduplicates registry indexes that duplicate core preset composites', () => {
    const entries: RegistryEntry[] = [
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [{ fields: ['aType', 'axbType'] }], // already in default preset
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    expect(config.indexes).toHaveLength(4);
  });

  it('deduplicates identical registry indexes across multiple entries', () => {
    const shared: IndexSpec = { fields: ['aType', 'axbType', 'data.status'] };
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'is', bType: 'task', indexes: [shared] },
      { aType: 'agent', axbType: 'is', bType: 'agent', indexes: [shared] },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // 4 default + 1 shared (not 2)
    expect(config.indexes).toHaveLength(5);
  });

  it('skips entries without indexes', () => {
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'is', bType: 'task' },
      { aType: 'agent', axbType: 'is', bType: 'agent' },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    expect(config.indexes).toHaveLength(4);
  });
});

describe('generateIndexConfig — where / partial indexes', () => {
  beforeEach(() => {
    _resetIndexGenWarningsForTest();
  });

  afterEach(() => {
    _resetIndexGenWarningsForTest();
  });

  it('drops specs with `where` and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entries: RegistryEntry[] = [
      {
        aType: 'task',
        axbType: 'is',
        bType: 'task',
        indexes: [
          {
            fields: ['aType', 'axbType', 'data.status'],
            where: "json_extract(data, '$.archived') = 0",
          },
        ],
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // Partial index dropped; only the 4 default composites remain.
    expect(config.indexes).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/IndexSpec\.where is ignored/);

    warn.mockRestore();
  });

  it('only warns once even across multiple generate calls', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spec: IndexSpec = { fields: ['aType', 'axbType'], where: 'x = 1' };
    const entries: RegistryEntry[] = [{ aType: 't', axbType: 'is', bType: 't', indexes: [spec] }];
    generateIndexConfig('graph', { registryEntries: entries });
    generateIndexConfig('graph', { registryEntries: entries });
    generateIndexConfig('graph', { registryEntries: entries });

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('generateIndexConfig — collection group (targetGraph) mirrors', () => {
  it('mirrors every composite under each distinct targetGraph', () => {
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'is', bType: 'task' },
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // 4 default COLLECTION composites + 4 COLLECTION_GROUP mirrors
    expect(config.indexes).toHaveLength(8);

    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    expect(cg).toHaveLength(4);
    for (const idx of cg) {
      expect(idx.collectionGroup).toBe('workflow');
    }

    const paths = cg.map(fieldPaths);
    expect(paths).toContain('aUid, axbType');
    expect(paths).toContain('axbType, bUid');
    expect(paths).toContain('aType, axbType');
    expect(paths).toContain('axbType, bType');
  });

  it('dedupes mirrors across multiple entries sharing the same targetGraph', () => {
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      { aType: 'task', axbType: 'ownedBy', bType: 'user', targetGraph: 'workflow' },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // Only 4 mirrors (not 8) — both entries share the same targetGraph.
    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    expect(cg).toHaveLength(4);
  });

  it('emits separate CG index sets for distinct targetGraph names', () => {
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      {
        aType: 'project',
        axbType: 'hasMilestone',
        bType: 'milestone',
        targetGraph: 'milestones',
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    // 4 composites × 2 distinct targetGraph names = 8.
    expect(cg).toHaveLength(8);
    expect(cg.filter((idx) => idx.collectionGroup === 'workflow')).toHaveLength(4);
    expect(cg.filter((idx) => idx.collectionGroup === 'milestones')).toHaveLength(4);
  });

  it('emits mirrors for per-entry indexes as well as core composites', () => {
    const entries: RegistryEntry[] = [
      {
        aType: 'task',
        axbType: 'assignedTo',
        bType: 'agent',
        targetGraph: 'workflow',
        indexes: [{ fields: ['aType', 'axbType', 'data.status'] }],
      },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    // 4 default COLLECTION + 1 per-entry COLLECTION + 4 default CG + 1 per-entry CG = 10
    expect(config.indexes).toHaveLength(10);

    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    expect(cg).toHaveLength(5);
    expect(cg.map(fieldPaths)).toContain('aType, axbType, data.status');
  });

  it('emits no CG indexes when no entries declare targetGraph', () => {
    const entries: RegistryEntry[] = [
      { aType: 'task', axbType: 'is', bType: 'task' },
      { aType: 'task', axbType: 'hasStep', bType: 'step' },
    ];
    const config = generateIndexConfig('graph', { registryEntries: entries });
    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    expect(cg).toHaveLength(0);
  });

  it('picks up targetGraph from DiscoveryResult.edges', () => {
    const entities: DiscoveryResult = {
      nodes: new Map<string, DiscoveredEntity>(),
      edges: new Map<string, DiscoveredEntity>([
        [
          'assignedTo',
          {
            kind: 'edge',
            name: 'assignedTo',
            schema: { type: 'object' },
            topology: { from: 'task', to: 'agent', targetGraph: 'workflow' },
          },
        ],
      ]),
    };
    const config = generateIndexConfig('graph', { entities });
    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    // 4 default composites mirrored under 'workflow'
    expect(cg).toHaveLength(4);
    for (const idx of cg) {
      expect(idx.collectionGroup).toBe('workflow');
    }
  });

  it('prefers DiscoveredEntity.targetGraph over topology.targetGraph', () => {
    const entities: DiscoveryResult = {
      nodes: new Map(),
      edges: new Map<string, DiscoveredEntity>([
        [
          'e',
          {
            kind: 'edge',
            name: 'e',
            schema: { type: 'object' },
            targetGraph: 'fromEntity',
            topology: { from: 'a', to: 'b', targetGraph: 'fromTopology' },
          },
        ],
      ]),
    };
    const config = generateIndexConfig('graph', { entities });
    const cg = config.indexes.filter((idx) => idx.queryScope === 'COLLECTION_GROUP');
    expect(cg.every((idx) => idx.collectionGroup === 'fromEntity')).toBe(true);
    expect(cg.some((idx) => idx.collectionGroup === 'fromTopology')).toBe(false);
  });
});

describe('generateIndexConfig — field ordering', () => {
  it('honors { path, desc: true } in IndexSpec fields', () => {
    const config = generateIndexConfig('graph', {
      coreIndexes: [
        {
          fields: ['aType', { path: 'createdAt', desc: true }],
        },
      ],
    });
    expect(config.indexes).toHaveLength(1);
    const idx = config.indexes[0];
    expect(idx.fields[0]).toEqual({ fieldPath: 'aType', order: 'ASCENDING' });
    expect(idx.fields[1]).toEqual({ fieldPath: 'createdAt', order: 'DESCENDING' });
  });
});

describe('generateIndexConfig — smoke', () => {
  it('default preset structure matches DEFAULT_CORE_INDEXES composites', () => {
    const compositeCount = DEFAULT_CORE_INDEXES.filter((s) => s.fields.length >= 2).length;
    const config = generateIndexConfig('graph');
    expect(config.indexes).toHaveLength(compositeCount);
  });
});
