import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TraversalError } from '../../src/errors.js';
import { createRegistry } from '../../src/registry.js';
import { _resetCrossGraphWarning, createTraversal } from '../../src/traverse.js';
import type { FindEdgesParams, GraphReader, StoredGraphRecord } from '../../src/types.js';

function makeEdge(overrides: Partial<StoredGraphRecord>): StoredGraphRecord {
  return {
    aType: 'a',
    aUid: 'a1',
    axbType: 'rel',
    bType: 'b',
    bUid: 'b1',
    data: {},
    createdAt: { seconds: 0, nanoseconds: 0 } as any,
    updatedAt: { seconds: 0, nanoseconds: 0 } as any,
    ...overrides,
  };
}

function createMockReader(
  findEdgesImpl: (params: FindEdgesParams) => Promise<StoredGraphRecord[]>,
): GraphReader {
  return {
    getNode: vi.fn().mockResolvedValue(null),
    getEdge: vi.fn().mockResolvedValue(null),
    edgeExists: vi.fn().mockResolvedValue(false),
    findEdges: vi.fn(findEdgesImpl),
    findNodes: vi.fn().mockResolvedValue([]),
  };
}

describe('createTraversal', () => {
  describe('builder', () => {
    it('throws TraversalError when run() called with zero hops', async () => {
      const reader = createMockReader(async () => []);
      await expect(createTraversal(reader, 'start').run()).rejects.toThrow(TraversalError);
      await expect(createTraversal(reader, 'start').run()).rejects.toThrow(
        'Traversal requires at least one follow() hop',
      );
    });

    it('accumulates multiple hops via chaining', async () => {
      const reader = createMockReader(async () => []);
      const builder = createTraversal(reader, 'start').follow('relA').follow('relB').follow('relC');

      const result = await builder.run();
      expect(result.hops).toHaveLength(3);
    });

    it('applies default options (limit=10, maxReads=100, concurrency=5)', async () => {
      const edges = Array.from({ length: 15 }, (_, i) =>
        makeEdge({ aUid: 'start', bUid: `b${i}`, axbType: 'rel' }),
      );
      const reader = createMockReader(async () => edges);

      await createTraversal(reader, 'start').follow('rel').run();

      // Default limit=10 is applied at Firestore level (via params.limit)
      // The reader was called with limit=10
      const call = (reader.findEdges as any).mock.calls[0][0];
      expect(call.limit).toBe(10);
    });

    it('direction defaults to forward', async () => {
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start').follow('rel').run();

      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.aUid).toBe('start');
      expect(call.bUid).toBeUndefined();
    });
  });

  describe('single hop', () => {
    it('returns edges from forward hop', async () => {
      const edges = [
        makeEdge({ aUid: 'tour1', bUid: 'dep1', axbType: 'hasDeparture' }),
        makeEdge({ aUid: 'tour1', bUid: 'dep2', axbType: 'hasDeparture' }),
      ];
      const reader = createMockReader(async (params) => {
        if (params.aUid === 'tour1' && params.axbType === 'hasDeparture') return edges;
        return [];
      });

      const result = await createTraversal(reader, 'tour1').follow('hasDeparture').run();

      expect(result.nodes).toHaveLength(2);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(false);
      expect(result.hops).toHaveLength(1);
      expect(result.hops[0].depth).toBe(0);
      expect(result.hops[0].sourceCount).toBe(1);
    });

    it('returns edges from reverse hop', async () => {
      const edges = [makeEdge({ aUid: 'dep1', bUid: 'rider1', axbType: 'hasRider' })];
      const reader = createMockReader(async (params) => {
        if (params.bUid === 'rider1' && params.axbType === 'hasRider') return edges;
        return [];
      });

      const result = await createTraversal(reader, 'rider1')
        .follow('hasRider', { direction: 'reverse' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aUid).toBe('dep1');
      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.bUid).toBe('rider1');
      expect(call.aUid).toBeUndefined();
    });
  });

  describe('multi-hop', () => {
    it('chains two hops correctly', async () => {
      const reader = createMockReader(async (params) => {
        if (params.aUid === 'tour1' && params.axbType === 'hasDep') {
          return [
            makeEdge({ aUid: 'tour1', bUid: 'dep1', axbType: 'hasDep' }),
            makeEdge({ aUid: 'tour1', bUid: 'dep2', axbType: 'hasDep' }),
          ];
        }
        if (params.axbType === 'hasRider') {
          if (params.aUid === 'dep1') {
            return [makeEdge({ aUid: 'dep1', bUid: 'rider1', axbType: 'hasRider' })];
          }
          if (params.aUid === 'dep2') {
            return [makeEdge({ aUid: 'dep2', bUid: 'rider2', axbType: 'hasRider' })];
          }
        }
        return [];
      });

      const result = await createTraversal(reader, 'tour1')
        .follow('hasDep')
        .follow('hasRider')
        .run();

      expect(result.nodes).toHaveLength(2);
      expect(result.hops).toHaveLength(2);
      expect(result.totalReads).toBe(3); // 1 for tour, 2 for departures
      expect(result.hops[0].sourceCount).toBe(1);
      expect(result.hops[1].sourceCount).toBe(2);
    });

    it('stops with empty result when intermediate hop has no edges', async () => {
      const reader = createMockReader(async () => []);

      const result = await createTraversal(reader, 'tour1')
        .follow('hasDep')
        .follow('hasRider')
        .run();

      expect(result.nodes).toHaveLength(0);
      expect(result.hops).toHaveLength(2);
      expect(result.hops[1].sourceCount).toBe(0);
      expect(result.totalReads).toBe(1);
    });
  });

  describe('budget enforcement', () => {
    it('stops when maxReads is reached', async () => {
      const reader = createMockReader(async (params) => {
        if (params.axbType === 'hasDep') {
          return Array.from({ length: 5 }, (_, i) =>
            makeEdge({ aUid: params.aUid!, bUid: `dep${i}`, axbType: 'hasDep' }),
          );
        }
        if (params.axbType === 'hasRider') {
          return [
            makeEdge({ aUid: params.aUid!, bUid: `rider-${params.aUid}`, axbType: 'hasRider' }),
          ];
        }
        return [];
      });

      const result = await createTraversal(reader, 'tour1')
        .follow('hasDep')
        .follow('hasRider')
        .run({ maxReads: 3 });

      expect(result.totalReads).toBeLessThanOrEqual(3);
      expect(result.truncated).toBe(true);
    });

    it('budget check happens before each query', async () => {
      let callCount = 0;
      const reader = createMockReader(async () => {
        callCount++;
        return [makeEdge({ bUid: `n${callCount}` })];
      });

      await createTraversal(reader, 'start').follow('rel').run({ maxReads: 1 });

      expect(callCount).toBe(1);
    });
  });

  describe('per-hop limit', () => {
    it('passes custom limit to findEdges params', async () => {
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start').follow('rel', { limit: 3 }).run();

      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.limit).toBe(3);
    });
  });

  describe('in-memory filter', () => {
    it('applies filter callback and respects limit after filtering', async () => {
      const edges = [
        makeEdge({ bUid: 'a', data: { status: 'confirmed' } }),
        makeEdge({ bUid: 'b', data: { status: 'pending' } }),
        makeEdge({ bUid: 'c', data: { status: 'confirmed' } }),
        makeEdge({ bUid: 'd', data: { status: 'confirmed' } }),
      ];
      const reader = createMockReader(async () => edges);

      const result = await createTraversal(reader, 'start')
        .follow('rel', {
          limit: 2,
          filter: (e) => e.data.status === 'confirmed',
        })
        .run();

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes.every((e) => e.data.status === 'confirmed')).toBe(true);
    });

    it('passes limit: 0 to Firestore when filter is used (bypass default limit)', async () => {
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start')
        .follow('rel', { limit: 5, filter: () => true })
        .run();

      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.limit).toBe(0);
    });
  });

  describe('bType/aType filters', () => {
    it('passes bType in forward direction', async () => {
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start').follow('rel', { bType: 'departure' }).run();

      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.bType).toBe('departure');
    });

    it('passes aType in reverse direction', async () => {
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start')
        .follow('rel', { direction: 'reverse', aType: 'departure' })
        .run();

      const call = (reader.findEdges as any).mock.calls[0][0] as FindEdgesParams;
      expect(call.aType).toBe('departure');
    });
  });

  describe('deduplication', () => {
    it('deduplicates source UIDs between hops', async () => {
      const reader = createMockReader(async (params) => {
        if (params.axbType === 'rel1') {
          return [
            makeEdge({ aUid: 'start', bUid: 'shared', axbType: 'rel1' }),
            makeEdge({ aUid: 'start', bUid: 'shared', axbType: 'rel1' }),
          ];
        }
        if (params.axbType === 'rel2') {
          return [makeEdge({ aUid: params.aUid!, bUid: 'end', axbType: 'rel2' })];
        }
        return [];
      });

      const result = await createTraversal(reader, 'start').follow('rel1').follow('rel2').run();

      // Should only query once for 'shared' in second hop despite duplicates
      expect(result.hops[1].sourceCount).toBe(1);
      expect(result.totalReads).toBe(2);
    });
  });

  describe('returnIntermediates', () => {
    it('hops always contain edges regardless of returnIntermediates', async () => {
      const reader = createMockReader(async (params) => {
        if (params.axbType === 'rel1') {
          return [makeEdge({ aUid: 'start', bUid: 'mid', axbType: 'rel1' })];
        }
        if (params.axbType === 'rel2') {
          return [makeEdge({ aUid: 'mid', bUid: 'end', axbType: 'rel2' })];
        }
        return [];
      });

      const resultWithout = await createTraversal(reader, 'start')
        .follow('rel1')
        .follow('rel2')
        .run({ returnIntermediates: false });

      expect(resultWithout.hops[0].edges).toHaveLength(1);

      const resultWith = await createTraversal(reader, 'start')
        .follow('rel1')
        .follow('rel2')
        .run({ returnIntermediates: true });

      expect(resultWith.hops[0].edges).toHaveLength(1);
    });
  });

  describe('cross-graph with non-GraphClient reader', () => {
    beforeEach(() => {
      _resetCrossGraphWarning();
    });

    it('falls back to local query when reader lacks subgraph()', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const edges = [makeEdge({ aUid: 'task1', bUid: 'agent1', axbType: 'assignedTo' })];
      const reader = createMockReader(async (params) => {
        if (params.aUid === 'task1' && params.axbType === 'assignedTo') return edges;
        return [];
      });

      const registry = createRegistry([
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      ]);

      // Plain reader (no subgraph method) — should still work, just queries locally
      const result = await createTraversal(reader, 'task1', registry).follow('assignedTo').run();

      expect(result.nodes).toHaveLength(1);
      expect(result.totalReads).toBe(1);
      warnSpy.mockRestore();
    });

    it('explicit targetGraph on hop is ignored for non-GraphClient reader', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reader = createMockReader(async () => []);

      const result = await createTraversal(reader, 'start')
        .follow('assignedTo', { targetGraph: 'workflow' })
        .run();

      expect(result.nodes).toHaveLength(0);
      expect(result.totalReads).toBe(1);
      // No error — just queried locally
      warnSpy.mockRestore();
    });

    it('emits one-time console.warn for cross-graph hop on plain reader (registry)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reader = createMockReader(async () => []);
      const registry = createRegistry([
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      ]);

      await createTraversal(reader, 'task1', registry).follow('assignedTo').run();

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('assignedTo');
      expect(warnSpy.mock.calls[0][0]).toContain('workflow');
      expect(warnSpy.mock.calls[0][0]).toContain('GraphClient');

      warnSpy.mockRestore();
    });

    it('emits one-time console.warn for cross-graph hop on plain reader (explicit)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start').follow('rel', { targetGraph: 'sub' }).run();

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('sub');

      warnSpy.mockRestore();
    });

    it('only warns once across multiple traversals', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reader = createMockReader(async () => []);

      await createTraversal(reader, 'start').follow('rel', { targetGraph: 'sub' }).run();

      await createTraversal(reader, 'start').follow('rel', { targetGraph: 'sub' }).run();

      expect(warnSpy).toHaveBeenCalledOnce();

      warnSpy.mockRestore();
    });
  });

  describe('cross-graph targetGraph resolution', () => {
    it('hop.targetGraph takes precedence over registry', async () => {
      const subgraphReader = createMockReader(async () => [
        makeEdge({ aUid: 'task1', bUid: 'agent1', axbType: 'assignedTo' }),
      ]);

      const registry = createRegistry([
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      ]);

      // Create a mock GraphClient with subgraph method
      const mockClient = {
        ...createMockReader(async () => []),
        subgraph: vi.fn().mockReturnValue(subgraphReader),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
      };

      // Override with explicit targetGraph 'team' (not 'workflow' from registry)
      await createTraversal(mockClient, 'task1', registry)
        .follow('assignedTo', { targetGraph: 'team' })
        .run();

      // subgraph should be called with 'team', not 'workflow'
      expect(mockClient.subgraph).toHaveBeenCalledWith('task1', 'team');
    });
  });

  describe('multi-hop context tracking', () => {
    it('carries forward subgraph reader to subsequent hops without targetGraph', async () => {
      const subgraphReader = createMockReader(async (params) => {
        if (params.axbType === 'hasStep') {
          return [
            makeEdge({
              aUid: params.aUid!,
              bUid: 'step1',
              axbType: 'hasStep',
              aType: 'task',
              bType: 'step',
            }),
          ];
        }
        if (params.axbType === 'hasDetail') {
          return [
            makeEdge({
              aUid: params.aUid!,
              bUid: 'detail1',
              axbType: 'hasDetail',
              aType: 'step',
              bType: 'detail',
            }),
          ];
        }
        return [];
      });

      const rootReader = createMockReader(async () => []);

      const mockClient = {
        ...rootReader,
        subgraph: vi.fn().mockReturnValue(subgraphReader),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
      };

      const result = await createTraversal(mockClient, 'task1')
        .follow('hasStep', { targetGraph: 'workflow' }) // crosses into subgraph
        .follow('hasDetail') // should stay in subgraph
        .run();

      // Hop 1 crosses into subgraph — subgraph() called
      expect(mockClient.subgraph).toHaveBeenCalledWith('task1', 'workflow');

      // Hop 2 should query the subgraph reader (not root)
      expect(subgraphReader.findEdges).toHaveBeenCalledTimes(2); // once for hasStep, once for hasDetail
      expect(rootReader.findEdges).not.toHaveBeenCalled();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].bUid).toBe('detail1');
      expect(result.totalReads).toBe(2);
    });

    it('explicit targetGraph on later hop overrides carried context (relative to root)', async () => {
      const workflowReader = createMockReader(async (params) => {
        if (params.axbType === 'hasStep') {
          return [makeEdge({ aUid: params.aUid!, bUid: 'step1', axbType: 'hasStep' })];
        }
        return [];
      });

      const teamReader = createMockReader(async (params) => {
        if (params.axbType === 'assignedTo') {
          return [makeEdge({ aUid: params.aUid!, bUid: 'agent1', axbType: 'assignedTo' })];
        }
        return [];
      });

      const rootReader = createMockReader(async () => []);

      const mockClient = {
        ...rootReader,
        subgraph: vi.fn((uid: string, name: string) => {
          if (name === 'workflow') return workflowReader;
          if (name === 'team') return teamReader;
          return rootReader;
        }),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
      };

      const result = await createTraversal(mockClient, 'task1')
        .follow('hasStep', { targetGraph: 'workflow' }) // crosses into workflow
        .follow('assignedTo', { targetGraph: 'team' }) // crosses into team (relative to root)
        .run();

      // First hop: subgraph('task1', 'workflow')
      // Second hop: subgraph('step1', 'team') — relative to root, not nested
      expect(mockClient.subgraph).toHaveBeenCalledWith('task1', 'workflow');
      expect(mockClient.subgraph).toHaveBeenCalledWith('step1', 'team');
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].bUid).toBe('agent1');
    });

    it('root reader stays as root when no cross-graph hops', async () => {
      const rootReader = createMockReader(async (params) => {
        if (params.axbType === 'rel1') {
          return [makeEdge({ aUid: params.aUid!, bUid: 'mid', axbType: 'rel1' })];
        }
        if (params.axbType === 'rel2') {
          return [makeEdge({ aUid: params.aUid!, bUid: 'end', axbType: 'rel2' })];
        }
        return [];
      });

      const result = await createTraversal(rootReader, 'start').follow('rel1').follow('rel2').run();

      // All queries go to root reader
      expect(rootReader.findEdges).toHaveBeenCalledTimes(2);
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].bUid).toBe('end');
    });

    it('handles budget exhaustion mid-cross-graph traversal', async () => {
      const subgraphReader = createMockReader(async (params) => {
        if (params.axbType === 'hasStep') {
          return Array.from({ length: 5 }, (_, i) =>
            makeEdge({ aUid: params.aUid!, bUid: `step${i}`, axbType: 'hasStep' }),
          );
        }
        if (params.axbType === 'hasDetail') {
          return [
            makeEdge({ aUid: params.aUid!, bUid: `detail-${params.aUid}`, axbType: 'hasDetail' }),
          ];
        }
        return [];
      });

      const rootReader = createMockReader(async () => []);
      const mockClient = {
        ...rootReader,
        subgraph: vi.fn().mockReturnValue(subgraphReader),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
      };

      const result = await createTraversal(mockClient, 'task1')
        .follow('hasStep', { targetGraph: 'workflow' })
        .follow('hasDetail')
        .run({ maxReads: 3 });

      // Budget: 3. Hop 1 uses 1 read (gets 5 steps). Hop 2 can do 2 more reads.
      expect(result.totalReads).toBeLessThanOrEqual(3);
      expect(result.truncated).toBe(true);
      // The partial results from hop 2 should still be present
      expect(result.hops).toHaveLength(2);
    });

    it('deduplicates UIDs across different subgraph readers (first wins)', async () => {
      // Two sources from different subgraphs both find the same target UID
      const subgraphA = createMockReader(async () => [
        makeEdge({ aUid: 'srcA', bUid: 'shared', axbType: 'rel' }),
      ]);
      const subgraphB = createMockReader(async () => [
        makeEdge({ aUid: 'srcB', bUid: 'shared', axbType: 'rel' }),
      ]);

      const rootReader = createMockReader(async (params) => {
        if (params.axbType === 'split') {
          return [
            makeEdge({ aUid: 'start', bUid: 'srcA', axbType: 'split' }),
            makeEdge({ aUid: 'start', bUid: 'srcB', axbType: 'split' }),
          ];
        }
        return [];
      });

      const mockClient = {
        ...rootReader,
        subgraph: vi.fn((uid: string) => {
          if (uid === 'srcA') return subgraphA;
          if (uid === 'srcB') return subgraphB;
          return rootReader;
        }),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
      };

      const result = await createTraversal(mockClient, 'start')
        .follow('split')
        .follow('rel', { targetGraph: 'sub' })
        .follow('next')
        .run();

      // 'shared' appears from both subgraphA and subgraphB,
      // but should only be queried once in the next hop (first reader wins).
      // The third hop should query either subgraphA or subgraphB (whichever came first).
      expect(result.hops[2].sourceCount).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('respects concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const edges = Array.from({ length: 5 }, (_, i) =>
        makeEdge({ aUid: 'start', bUid: `n${i}`, axbType: 'rel1' }),
      );

      const reader = createMockReader(async (params) => {
        if (params.axbType === 'rel1') return edges;
        if (params.axbType === 'rel2') {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
          return [makeEdge({ aUid: params.aUid!, bUid: `end-${params.aUid}`, axbType: 'rel2' })];
        }
        return [];
      });

      await createTraversal(reader, 'start').follow('rel1').follow('rel2').run({ concurrency: 2 });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });
});
