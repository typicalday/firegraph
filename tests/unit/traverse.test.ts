import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TraversalError } from '../../src/errors.js';
import { createRegistry } from '../../src/registry.js';
import { _resetCrossGraphWarning, createTraversal } from '../../src/traverse.js';
import type {
  EngineTraversalParams,
  EngineTraversalResult,
  ExpandParams,
  FindEdgesParams,
  GraphReader,
  StoredGraphRecord,
} from '../../src/types.js';

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

  // ---------------------------------------------------------------------------
  // Phase 6: query.join fast path
  //
  // When the reader is a `GraphClient`, declares `query.join`, and exposes a
  // working `expand()` method, traversal collapses each hop's per-source
  // `findEdges` loop into a single `expand()` call. These tests pin that
  // dispatch and the carve-outs that fall back to the slow path.
  // ---------------------------------------------------------------------------
  describe('query.join fast path', () => {
    /**
     * Build a GraphClient-shaped mock that opts into the `query.join`
     * fast path. Tracks both `findEdges` and `expand` calls so a test can
     * assert exactly which path the traversal took. `expandImpl` defaults
     * to a static empty result so unsupplied tests never accidentally
     * exercise data-shape assertions.
     */
    function makeJoinClient(opts: {
      hasJoin?: boolean;
      expandImpl?: (params: ExpandParams) => Promise<{
        edges: StoredGraphRecord[];
      }>;
      findEdgesImpl?: (params: FindEdgesParams) => Promise<StoredGraphRecord[]>;
    }) {
      const hasJoin = opts.hasJoin ?? true;
      const expandFn = vi.fn(opts.expandImpl ?? (async () => ({ edges: [] })));
      const findEdgesFn = vi.fn(opts.findEdgesImpl ?? (async () => []));

      const client: any = {
        getNode: vi.fn().mockResolvedValue(null),
        getEdge: vi.fn().mockResolvedValue(null),
        edgeExists: vi.fn().mockResolvedValue(false),
        findEdges: findEdgesFn,
        findNodes: vi.fn().mockResolvedValue([]),
        // Marks this as a `GraphClient` for the `isGraphClient` guard.
        subgraph: vi.fn(),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
        capabilities: {
          has: (c: string) => c === 'query.join' && hasJoin,
          values: () => (hasJoin ? ['query.join'] : []).values(),
        },
      };
      if (hasJoin) {
        client.expand = expandFn;
      }
      return { client, expandFn, findEdgesFn };
    }

    it('dispatches one expand() per hop instead of per-source findEdges', async () => {
      // The whole point of `query.join`: a hop with N sources collapses to
      // one server round-trip. After the start node, hop 1 produces 3
      // edges → 3 sources for hop 2; hop 2 must call `expand` once with
      // all 3 sources rather than three separate `findEdges`.
      const { client, expandFn, findEdgesFn } = makeJoinClient({
        expandImpl: async (params) => {
          if (params.axbType === 'rel1') {
            return {
              edges: [
                makeEdge({ aUid: 'start', bUid: 's1', axbType: 'rel1' }),
                makeEdge({ aUid: 'start', bUid: 's2', axbType: 'rel1' }),
                makeEdge({ aUid: 'start', bUid: 's3', axbType: 'rel1' }),
              ],
            };
          }
          if (params.axbType === 'rel2') {
            return {
              edges: params.sources.map((u) =>
                makeEdge({ aUid: u, bUid: `end-${u}`, axbType: 'rel2' }),
              ),
            };
          }
          return { edges: [] };
        },
      });

      const result = await createTraversal(client, 'start').follow('rel1').follow('rel2').run();

      // 1 call per hop = 2 total. Slow path would have been 1 + 3 = 4.
      expect(expandFn).toHaveBeenCalledTimes(2);
      expect(findEdgesFn).not.toHaveBeenCalled();
      expect(expandFn.mock.calls[1][0].sources).toEqual(['s1', 's2', 's3']);
      // Budget: one expand() = one read, regardless of source count. This
      // is a documented behaviour change vs. the slow path (which would
      // have charged 3 reads for hop 2). The traversal walker comment
      // calls it out as "an improvement, not a regression".
      expect(result.totalReads).toBe(2);
      expect(result.nodes).toHaveLength(3);
    });

    it('falls back to per-source findEdges when the reader lacks query.join', async () => {
      // Capability descriptor lies → the runtime guard catches it. This
      // is the inverse direction of the "declared cap ⇒ method exists"
      // invariant: a missing cap must skip the fast path even if the
      // method itself is defined. Otherwise the traversal walker could
      // call a backend that throws `UNSUPPORTED_OPERATION` at runtime.
      const { client, expandFn, findEdgesFn } = makeJoinClient({
        hasJoin: false,
        findEdgesImpl: async (params) => {
          if (params.axbType === 'rel') {
            return [
              makeEdge({ aUid: 'start', bUid: 's1', axbType: 'rel' }),
              makeEdge({ aUid: 'start', bUid: 's2', axbType: 'rel' }),
            ];
          }
          return [];
        },
      });

      await createTraversal(client, 'start').follow('rel').run();

      expect(expandFn).not.toHaveBeenCalled();
      expect(findEdgesFn).toHaveBeenCalledTimes(1);
    });

    it('falls back to per-source loop for cross-graph hops even when query.join is supported', async () => {
      // Cross-graph hops resolve each source UID to a distinct subgraph
      // reader (via `client.subgraph(sourceUid, name)`). Those readers
      // can't be batched into one statement — the per-DO sharding model
      // means each subgraph backend is its own physical database.
      // Traversal explicitly skips the fast path for cross-graph hops.
      const expandFn = vi.fn(async (params: ExpandParams) => {
        // Hop 1 (`split`) is non-cross-graph and takes the fast path.
        // Hop 2 (`rel`, targetGraph: 'sub') must NOT reach this fn — the
        // assertion below pins that.
        if (params.axbType === 'split') {
          return {
            edges: [
              makeEdge({ aUid: 'start', bUid: 'srcA', axbType: 'split' }),
              makeEdge({ aUid: 'start', bUid: 'srcB', axbType: 'split' }),
            ],
          };
        }
        return { edges: [] };
      });
      const subgraphReaderA = createMockReader(async () => [
        makeEdge({ aUid: 'srcA', bUid: 't1', axbType: 'rel' }),
      ]);
      const subgraphReaderB = createMockReader(async () => [
        makeEdge({ aUid: 'srcB', bUid: 't2', axbType: 'rel' }),
      ]);

      const rootReader = createMockReader(async () => []);

      const client: any = {
        ...rootReader,
        subgraph: vi.fn((uid: string) => {
          if (uid === 'srcA') return subgraphReaderA;
          if (uid === 'srcB') return subgraphReaderB;
          return rootReader;
        }),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
        expand: expandFn,
        capabilities: {
          has: (c: string) => c === 'query.join',
          values: () => ['query.join'].values(),
        },
      };

      const result = await createTraversal(client, 'start')
        .follow('split')
        .follow('rel', { targetGraph: 'sub' })
        .run();

      // Hop 1 (no targetGraph) takes the fast path → 1 expand call.
      // Hop 2 is cross-graph → must use per-source findEdges on each
      // subgraph reader, NOT expand.
      expect(expandFn).toHaveBeenCalledTimes(1);
      expect(expandFn.mock.calls[0][0].axbType).toBe('split');
      expect(subgraphReaderA.findEdges).toHaveBeenCalledTimes(1);
      expect(subgraphReaderB.findEdges).toHaveBeenCalledTimes(1);
      expect(result.hops[1].edges.map((e) => e.bUid).sort()).toEqual(['t1', 't2']);
    });

    it('applies hop.filter as a JS post-predicate without limitPerSource on the SQL layer', async () => {
      // With `hop.filter` set, the limit must be enforced JS-side after
      // the predicate runs — passing `limitPerSource` to the SQL layer
      // would cap *pre-filter*, leaving fewer post-filter rows than the
      // user requested. The walker passes `limitPerSource: undefined` and
      // applies a per-source-counting limit in JS.
      const { client, expandFn } = makeJoinClient({
        expandImpl: async (params) => {
          if (params.axbType === 'rel') {
            return {
              edges: [
                makeEdge({ aUid: 'start', bUid: 'a', axbType: 'rel', data: { keep: true } }),
                makeEdge({ aUid: 'start', bUid: 'b', axbType: 'rel', data: { keep: false } }),
                makeEdge({ aUid: 'start', bUid: 'c', axbType: 'rel', data: { keep: true } }),
                makeEdge({ aUid: 'start', bUid: 'd', axbType: 'rel', data: { keep: true } }),
              ],
            };
          }
          return { edges: [] };
        },
      });

      const result = await createTraversal(client, 'start')
        .follow('rel', { limit: 2, filter: (e) => e.data.keep === true })
        .run();

      // limitPerSource intentionally NOT set on the expand call.
      expect(expandFn).toHaveBeenCalledTimes(1);
      expect(expandFn.mock.calls[0][0].limitPerSource).toBeUndefined();
      // Post-filter, post-limit: only the first 2 of 3 keepers survive
      // (per-source cap on `start` = 2).
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes.every((e) => e.data.keep === true)).toBe(true);
    });

    it('forwards hop.aType / hop.bType / hop.orderBy from hop options to expandParams', async () => {
      // Audit gap: the walker passes `hop.aType`, `hop.bType`, and
      // `hop.orderBy` into the expand params object (`src/traverse.ts`
      // line ~180). None of the other fast-path tests inspect those fields
      // on the call. A drop of one of those if-blocks would silently break
      // domain-typed traversals (e.g. "find departures with `bType:
      // departure` in createdAt-desc order") with no test failure.
      const { client, expandFn } = makeJoinClient({
        expandImpl: async () => ({
          edges: [makeEdge({ aUid: 'start', bUid: 'b1', axbType: 'rel' })],
        }),
      });

      await createTraversal(client, 'start')
        .follow('rel', {
          aType: 'agent',
          bType: 'note',
          orderBy: { field: 'createdAt', direction: 'desc' },
        })
        .run();

      expect(expandFn).toHaveBeenCalledTimes(1);
      const params = expandFn.mock.calls[0][0];
      expect(params.aType).toBe('agent');
      expect(params.bType).toBe('note');
      expect(params.orderBy).toEqual({ field: 'createdAt', direction: 'desc' });
    });

    it('falls back to per-source loop when sources have mixed readers (post cross-graph carry)', async () => {
      // Audit gap: the third bullet of the fast-path eligibility contract
      // (sources share a reader) was unguarded. Construct a 3-hop
      // traversal where:
      //   hop 1 (non-cross-graph) takes the fast path, producing 2 sources
      //         that all share the root reader.
      //   hop 2 is cross-graph: each of the 2 sources resolves to a
      //         different subgraph reader → after hop 2, sources have
      //         mixed readers.
      //   hop 3 has no `targetGraph` and inherits the mixed readers from
      //         hop 2's carry-forward. Hop 3 must NOT take the fast path
      //         because the sources don't share a reader.
      const expandFn = vi.fn(async (params: ExpandParams) => {
        if (params.axbType === 'split') {
          return {
            edges: [
              makeEdge({ aUid: 'start', bUid: 'srcA', axbType: 'split' }),
              makeEdge({ aUid: 'start', bUid: 'srcB', axbType: 'split' }),
            ],
          };
        }
        return { edges: [] };
      });
      const subgraphReaderA = createMockReader(async (params) => {
        if (params.axbType === 'rel') {
          return [makeEdge({ aUid: 'srcA', bUid: 'midA', axbType: 'rel' })];
        }
        if (params.axbType === 'tail') {
          return [makeEdge({ aUid: 'midA', bUid: 'endA', axbType: 'tail' })];
        }
        return [];
      });
      const subgraphReaderB = createMockReader(async (params) => {
        if (params.axbType === 'rel') {
          return [makeEdge({ aUid: 'srcB', bUid: 'midB', axbType: 'rel' })];
        }
        if (params.axbType === 'tail') {
          return [makeEdge({ aUid: 'midB', bUid: 'endB', axbType: 'tail' })];
        }
        return [];
      });

      const rootReader = createMockReader(async () => []);

      const client: any = {
        ...rootReader,
        subgraph: vi.fn((uid: string) => {
          if (uid === 'srcA') return subgraphReaderA;
          if (uid === 'srcB') return subgraphReaderB;
          return rootReader;
        }),
        runTransaction: vi.fn(),
        batch: vi.fn(),
        removeNodeCascade: vi.fn(),
        bulkRemoveEdges: vi.fn(),
        findEdgesGlobal: vi.fn(),
        expand: expandFn,
        capabilities: {
          has: (c: string) => c === 'query.join',
          values: () => ['query.join'].values(),
        },
      };

      const result = await createTraversal(client, 'start')
        .follow('split') // hop 1: fast-path (1 expand call) → [srcA, srcB] both with rootReader
        .follow('rel', { targetGraph: 'sub' }) // hop 2: cross-graph slow path; produces midA/subgraphA + midB/subgraphB → MIXED readers
        .follow('tail') // hop 3: no targetGraph, mixed readers → slow path
        .run();

      // Hop 1 took fast path: exactly 1 expand call (for 'split').
      expect(expandFn).toHaveBeenCalledTimes(1);
      expect(expandFn.mock.calls[0][0].axbType).toBe('split');
      // Hop 3 must have hit the slow path: each subgraph reader's
      // findEdges fired with axbType='tail'. Confirm both subgraph readers
      // saw it (one per mixed-reader source).
      const subAFEdges = (subgraphReaderA.findEdges as any).mock.calls.filter(
        (c: any[]) => c[0].axbType === 'tail',
      );
      const subBFEdges = (subgraphReaderB.findEdges as any).mock.calls.filter(
        (c: any[]) => c[0].axbType === 'tail',
      );
      expect(subAFEdges).toHaveLength(1);
      expect(subBFEdges).toHaveLength(1);
      expect(result.hops[2].edges.map((e) => e.bUid).sort()).toEqual(['endA', 'endB']);
    });

    it('honours maxReads — one expand call counts as one read', async () => {
      // Documented behaviour: each `expand()` round-trip = 1 charge against
      // `maxReads`. Setting `maxReads: 1` on a 2-hop traversal must short-
      // circuit the second hop with `truncated: true`. This pins the budget
      // semantics so a future "1 read per source" regression would fail
      // here rather than silently letting traversals overshoot the cap.
      const { client, expandFn } = makeJoinClient({
        expandImpl: async (params) => {
          if (params.axbType === 'rel1') {
            return {
              edges: [makeEdge({ aUid: 'start', bUid: 'mid', axbType: 'rel1' })],
            };
          }
          if (params.axbType === 'rel2') {
            return {
              edges: [makeEdge({ aUid: 'mid', bUid: 'end', axbType: 'rel2' })],
            };
          }
          return { edges: [] };
        },
      });

      const result = await createTraversal(client, 'start')
        .follow('rel1')
        .follow('rel2')
        .run({ maxReads: 1 });

      expect(expandFn).toHaveBeenCalledTimes(1);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(true);
    });
  });

  describe('engine traversal', () => {
    function makeEngineClient(
      engineImpl: (params: EngineTraversalParams) => Promise<EngineTraversalResult>,
    ) {
      const engineFn = vi.fn(engineImpl);
      const client = {
        getNode: vi.fn().mockResolvedValue(null),
        getEdge: vi.fn().mockResolvedValue(null),
        edgeExists: vi.fn().mockResolvedValue(false),
        findEdges: vi.fn().mockResolvedValue([]),
        findNodes: vi.fn().mockResolvedValue([]),
        subgraph: vi.fn(),
        capabilities: {
          has: (cap: string) => cap === 'traversal.serverSide',
          values: () => (['traversal.serverSide'] as const).values(),
        },
        runEngineTraversal: engineFn,
      };
      return { client, engineFn };
    }

    it('sets truncated:true when hop edge count equals limitPerSource', async () => {
      const limit = 3;
      const { client } = makeEngineClient(async (params) => ({
        hops: params.hops.map(() => ({
          edges: Array.from({ length: limit }, (_, i) =>
            makeEdge({ aUid: 'start', bUid: `b${i}`, axbType: 'rel' }),
          ),
          sourceCount: 1,
        })),
        totalReads: 1,
      }));

      const result = await createTraversal(client as any, 'start')
        .follow('rel', { limit })
        .run({ engineTraversal: 'force' });

      expect(result.hops[0].truncated).toBe(true);
      expect(result.truncated).toBe(true);
    });

    it('sets truncated:false when hop edge count is below limitPerSource', async () => {
      const limit = 10;
      const { client } = makeEngineClient(async (params) => ({
        hops: params.hops.map(() => ({
          edges: [makeEdge({ aUid: 'start', bUid: 'b0', axbType: 'rel' })],
          sourceCount: 1,
        })),
        totalReads: 1,
      }));

      const result = await createTraversal(client as any, 'start')
        .follow('rel', { limit })
        .run({ engineTraversal: 'force' });

      expect(result.hops[0].truncated).toBe(false);
      expect(result.truncated).toBe(false);
    });

    it('refuses a reverse cross-graph hop in force mode', async () => {
      const { client } = makeEngineClient(async () => ({ hops: [], totalReads: 1 }));

      await expect(
        createTraversal(client as any, 'start')
          .follow('rel', { direction: 'reverse', targetGraph: 'other' })
          .run({ engineTraversal: 'force' }),
      ).rejects.toThrow('cross-graph');
    });

    it('truncated:true propagates to overall result when any hop is truncated', async () => {
      const limit = 2;
      const { client } = makeEngineClient(async (params) => ({
        hops: params.hops.map((hop, i) => ({
          // first hop hits limit, second does not
          edges: Array.from({ length: i === 0 ? limit : 1 }, (_, j) =>
            makeEdge({
              aUid: i === 0 ? 'start' : 'mid0',
              bUid: `${i === 0 ? 'mid' : 'end'}${j}`,
              axbType: hop.axbType,
            }),
          ),
          sourceCount: i === 0 ? 1 : limit,
        })),
        totalReads: 1,
      }));

      const result = await createTraversal(client as any, 'start')
        .follow('rel1', { limit })
        .follow('rel2', { limit })
        .run({ engineTraversal: 'force' });

      expect(result.hops[0].truncated).toBe(true);
      expect(result.hops[1].truncated).toBe(false);
      expect(result.truncated).toBe(true);
    });
  });
});
