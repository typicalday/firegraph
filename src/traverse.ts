import { TraversalError } from './errors.js';
import type {
  ExpandParams,
  FindEdgesParams,
  GraphClient,
  GraphReader,
  GraphRegistry,
  HopDefinition,
  HopResult,
  StoredGraphRecord,
  TraversalBuilder,
  TraversalOptions,
  TraversalResult,
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

/**
 * Type guard to detect whether a reader has the `query.join` capability —
 * i.e. the backend supports server-side multi-source fan-out via `expand()`.
 *
 * Branching on this lets us dispatch one `expand()` call per hop instead of
 * one `findEdges()` per source. The savings scale linearly with source-set
 * size; for the common case of a 50-source hop, that's 50 round trips
 * collapsed into 1.
 *
 * Cross-graph hops are explicitly NOT routed through `expand()` even when
 * the cap is present — each source UID resolves to a distinct subgraph
 * reader, which can't be batched into one server-side statement. The
 * traversal driver enforces that boundary directly (see the `isCrossGraph`
 * branch below).
 */
function readerSupportsExpand(
  reader: GraphReader,
): reader is GraphClient & {
  expand(params: ExpandParams): Promise<{ edges: StoredGraphRecord[] }>;
} {
  if (!isGraphClient(reader)) return false;
  const client = reader as GraphClient;
  // `capabilities` lives on the public client surface (see `CoreGraphClient`).
  // The runtime check is required because `expand` exists on every
  // `GraphClientImpl` (the permissive `GraphClient<Capability>` shape) but
  // throws `UNSUPPORTED_OPERATION` when the backend doesn't declare the cap.
  // Reading `capabilities` instead of feeling for the method is the cap-aware
  // dispatch the rest of the codebase uses.
  return (
    'capabilities' in client &&
    typeof client.capabilities?.has === 'function' &&
    client.capabilities.has('query.join') &&
    typeof (client as { expand?: unknown }).expand === 'function'
  );
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

      // Fast path: server-side fan-out via `expand()` when the reader supports
      // `query.join`. Eligibility:
      //   1. Not a cross-graph hop — each cross-graph source resolves to its
      //      own subgraph reader, which can't be batched into one statement.
      //   2. All sources share the same reader. Mixed readers happen only
      //      after a previous cross-graph carry-forward; for the typical
      //      single-graph or fully-routed-to-one-DO case, this is true.
      //   3. The shared reader's backend declares `query.join`.
      //
      // Budget accounting: one `expand()` call counts as ONE read against
      // `maxReads`, regardless of source-set size. That reflects reality
      // (1 server round trip = 1 read) and is the entire point of the
      // capability — a 50-source hop collapses 50 round trips into 1.
      // Callers who expect "1 read per source" semantics from `maxReads`
      // will see traversals reach further than they did with the per-source
      // loop; this is an improvement, not a regression.
      // Fast-path eligibility check (3): sources share a reader. Mixed-reader
      // sources happen only after a cross-graph carry-forward (hop N had a
      // `targetGraph`, fanning each source UID into its own subgraph reader).
      // The empty-sources branch is already handled by the `if (sources.length === 0)`
      // continue earlier in the loop, so `sources` is non-empty here.
      const sharedReader = sources.every((s) => s.reader === sources[0].reader)
        ? sources[0].reader
        : null;
      const canFastPath = !isCrossGraph && sharedReader && readerSupportsExpand(sharedReader);

      if (canFastPath && sharedReader) {
        if (totalReads >= maxReads) {
          hopTruncated = true;
        } else {
          totalReads++;
          const limit = hop.limit ?? DEFAULT_LIMIT;
          const expandParams: ExpandParams = {
            sources: sources.map((s) => s.uid),
            axbType: hop.axbType,
            direction,
          };
          if (hop.aType) expandParams.aType = hop.aType;
          if (hop.bType) expandParams.bType = hop.bType;
          if (hop.orderBy) expandParams.orderBy = hop.orderBy;
          // With a hop-level `filter`, we can't apply `limitPerSource` at the
          // SQL layer — the filter is a JS predicate that runs after rows
          // come back. Pass undefined to fetch all matching edges, filter,
          // then enforce per-source limit in JS below.
          if (!hop.filter) {
            expandParams.limitPerSource = limit;
          }
          const result = await (
            sharedReader as GraphClient & {
              expand(p: ExpandParams): Promise<{ edges: StoredGraphRecord[] }>;
            }
          ).expand(expandParams);
          let edges = result.edges;
          if (hop.filter) {
            edges = edges.filter(hop.filter);
            // Enforce per-source post-filter limit. Without this, a source
            // whose post-filter edge count exceeds `limit` would carry
            // through more next-hop sources than the user requested.
            const counts = new Map<string, number>();
            const kept: StoredGraphRecord[] = [];
            for (const e of edges) {
              const sourceUid = direction === 'forward' ? e.aUid : e.bUid;
              const c = counts.get(sourceUid) ?? 0;
              if (c < limit) {
                counts.set(sourceUid, c + 1);
                kept.push(e);
              }
            }
            edges = kept;
          }
          for (const edge of edges) {
            hopEdges.push({ edge, reader: sharedReader });
          }
        }

        // Skip the per-source task loop — we already filled `hopEdges`.
        const fastEdges = hopEdges.map((h) => h.edge);
        hopResults.push({
          axbType: hop.axbType,
          depth,
          edges: returnIntermediates ? [...fastEdges] : fastEdges,
          sourceCount,
          truncated: hopTruncated,
        });
        if (hopTruncated) truncated = true;

        // Build next sources, same dedup logic as the slow path.
        const seen = new Map<string, GraphReader>();
        for (const { edge, reader: edgeReader } of hopEdges) {
          const nextUid = direction === 'forward' ? edge.bUid : edge.aUid;
          if (!seen.has(nextUid)) seen.set(nextUid, edgeReader);
        }
        sources = [...seen.entries()].map(([uid, reader]) => ({ uid, reader }));
        continue;
      }

      // Slow path (per-source loop): cross-graph hops, mixed-reader sources,
      // or backends without `query.join`.
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
