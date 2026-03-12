import { TraversalError } from './errors.js';
import type {
  GraphReader,
  GraphClient,
  GraphRegistry,
  StoredGraphRecord,
  FindEdgesParams,
  HopDefinition,
  TraversalOptions,
  HopResult,
  TraversalResult,
  TraversalBuilder,
} from './types.js';

const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_READS = 100;
const DEFAULT_CONCURRENCY = 5;

/** One-time warning flag: emitted when cross-graph hop is silently skipped. */
let _crossGraphWarned = false;

/** Type guard to check if a reader is a GraphClient (has subgraph method). */
function isGraphClient(reader: GraphReader): reader is GraphClient {
  return 'subgraph' in reader && typeof (reader as GraphClient).subgraph === 'function';
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly slots: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.slots) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

class TraversalBuilderImpl implements TraversalBuilder {
  private readonly hops: HopDefinition[] = [];

  constructor(
    private readonly reader: GraphReader,
    private readonly startUid: string,
    private readonly registry?: GraphRegistry,
  ) {}

  follow(axbType: string, options?: Omit<HopDefinition, 'axbType'>): TraversalBuilder {
    this.hops.push({ axbType, ...options });
    return this;
  }

  async run(options?: TraversalOptions): Promise<TraversalResult> {
    if (this.hops.length === 0) {
      throw new TraversalError('Traversal requires at least one follow() hop');
    }

    const maxReads = options?.maxReads ?? DEFAULT_MAX_READS;
    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    const returnIntermediates = options?.returnIntermediates ?? false;
    const semaphore = new Semaphore(concurrency);

    let totalReads = 0;
    let truncated = false;
    // Track (uid, reader) pairs to support context carry-forward across hops.
    // When a hop crosses into a subgraph, the resulting UIDs carry the subgraph
    // reader so subsequent hops without targetGraph stay in that subgraph.
    let sources: Array<{ uid: string; reader: GraphReader }> = [
      { uid: this.startUid, reader: this.reader },
    ];
    const hopResults: HopResult[] = [];

    for (let depth = 0; depth < this.hops.length; depth++) {
      const hop = this.hops[depth];

      if (sources.length === 0) {
        hopResults.push({
          axbType: hop.axbType,
          depth,
          edges: [],
          sourceCount: 0,
          truncated: false,
        });
        continue;
      }

      const hopEdges: Array<{ edge: StoredGraphRecord; reader: GraphReader }> = [];
      const sourceCount = sources.length;
      let hopTruncated = false;

      // Resolve targetGraph for this hop:
      // 1. Explicit on the hop definition takes precedence
      // 2. Otherwise check the registry for the axbType
      const resolvedTargetGraph = this.resolveTargetGraph(hop);
      const direction = hop.direction ?? 'forward';
      const isCrossGraph = direction === 'forward' && !!resolvedTargetGraph;

      const tasks = sources.map(({ uid, reader: sourceReader }) => async () => {
        if (totalReads >= maxReads) {
          hopTruncated = true;
          return;
        }

        await semaphore.acquire();
        try {
          if (totalReads >= maxReads) {
            hopTruncated = true;
            return;
          }

          totalReads++;

          const params: FindEdgesParams = { axbType: hop.axbType };

          if (direction === 'forward') {
            params.aUid = uid;
            if (hop.bType) params.bType = hop.bType;
          } else {
            params.bUid = uid;
            if (hop.aType) params.aType = hop.aType;
          }

          if (direction === 'forward' && hop.aType) {
            params.aType = hop.aType;
          }
          if (direction === 'reverse' && hop.bType) {
            params.bType = hop.bType;
          }

          if (hop.orderBy) params.orderBy = hop.orderBy;

          const limit = hop.limit ?? DEFAULT_LIMIT;
          if (hop.filter) {
            params.limit = 0;
          } else {
            params.limit = limit;
          }

          // Choose the reader for this hop:
          // - Cross-graph hop: create a subgraph reader from the ROOT client
          //   (targetGraph is always relative to root)
          // - No cross-graph: use the carried-forward reader from previous hop
          //   (context tracking — stay in whatever subgraph we're already in)
          let hopReader: GraphReader;
          let nextReader: GraphReader;
          if (isCrossGraph) {
            if (isGraphClient(this.reader)) {
              hopReader = this.reader.subgraph(uid, resolvedTargetGraph!);
              nextReader = hopReader;
            } else {
              hopReader = sourceReader;
              nextReader = sourceReader;
              if (!_crossGraphWarned) {
                _crossGraphWarned = true;
                console.warn(
                  `[firegraph] Traversal hop "${hop.axbType}" has targetGraph "${resolvedTargetGraph}" ` +
                  'but the reader does not support subgraph(). Cross-graph hop will query the current ' +
                  'collection instead. Pass a GraphClient to createTraversal() to enable cross-graph traversal.',
                );
              }
            }
          } else {
            // No targetGraph — carry forward context from previous hop
            hopReader = sourceReader;
            nextReader = sourceReader;
          }

          let edges = await hopReader.findEdges(params);

          if (hop.filter) {
            edges = edges.filter(hop.filter);
            edges = edges.slice(0, limit);
          }

          for (const edge of edges) {
            hopEdges.push({ edge, reader: nextReader });
          }
        } finally {
          semaphore.release();
        }
      });

      await Promise.all(tasks.map((task) => task()));

      const edges = hopEdges.map((h) => h.edge);

      hopResults.push({
        axbType: hop.axbType,
        depth,
        edges: returnIntermediates ? [...edges] : edges,
        sourceCount,
        truncated: hopTruncated,
      });

      if (hopTruncated) {
        truncated = true;
      }

      // Build next sources with deduplication by UID.
      // When the same UID appears from multiple source readers, the first one wins.
      const seen = new Map<string, GraphReader>();
      for (const { edge, reader: edgeReader } of hopEdges) {
        const nextUid = direction === 'forward' ? edge.bUid : edge.aUid;
        if (!seen.has(nextUid)) {
          seen.set(nextUid, edgeReader);
        }
      }
      sources = [...seen.entries()].map(([uid, reader]) => ({ uid, reader }));
    }

    const lastHop = hopResults[hopResults.length - 1];

    return {
      nodes: lastHop.edges,
      hops: hopResults,
      totalReads,
      truncated,
    };
  }

  /**
   * Resolve the targetGraph for a hop. Priority:
   * 1. Explicit `hop.targetGraph` (user override)
   * 2. Registry `targetGraph` for the axbType (if registry available)
   * 3. undefined (no cross-graph)
   */
  private resolveTargetGraph(hop: HopDefinition): string | undefined {
    if (hop.targetGraph) return hop.targetGraph;

    if (this.registry) {
      const entries = this.registry.lookupByAxbType(hop.axbType);
      // All entries for the same axbType should share targetGraph; use the first non-undefined
      for (const entry of entries) {
        if (entry.targetGraph) return entry.targetGraph;
      }
    }

    return undefined;
  }
}

/** @internal Reset the one-time cross-graph warning flag (for testing). */
export function _resetCrossGraphWarning(): void {
  _crossGraphWarned = false;
}

/**
 * Create a traversal builder for multi-hop graph traversal.
 *
 * Accepts either a `GraphReader` (backwards compatible) or a `GraphClient`.
 * When a `GraphClient` is provided, cross-graph traversal via `targetGraph`
 * is supported — the traversal can follow edges into subgraphs.
 *
 * @param reader - A `GraphClient` or `GraphReader` to execute queries against
 * @param startUid - UID of the starting node
 * @param registry - Optional registry for automatic `targetGraph` resolution
 */
export function createTraversal(
  reader: GraphClient | GraphReader,
  startUid: string,
  registry?: GraphRegistry,
): TraversalBuilder {
  return new TraversalBuilderImpl(reader, startUid, registry);
}
