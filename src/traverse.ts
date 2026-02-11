import { TraversalError } from './errors.js';
import type {
  GraphReader,
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
  ) {}

  follow(abType: string, options?: Omit<HopDefinition, 'abType'>): TraversalBuilder {
    this.hops.push({ abType, ...options });
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
    let sourceUids = [this.startUid];
    const hopResults: HopResult[] = [];

    for (let depth = 0; depth < this.hops.length; depth++) {
      const hop = this.hops[depth];

      if (sourceUids.length === 0) {
        hopResults.push({
          abType: hop.abType,
          depth,
          edges: [],
          sourceCount: 0,
          truncated: false,
        });
        continue;
      }

      const hopEdges: StoredGraphRecord[] = [];
      const sourceCount = sourceUids.length;
      let hopTruncated = false;

      const tasks = sourceUids.map((uid) => async () => {
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

          const direction = hop.direction ?? 'forward';
          const params: FindEdgesParams = { abType: hop.abType };

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
          if (!hop.filter) {
            params.limit = limit;
          }

          let edges = await this.reader.findEdges(params);

          if (hop.filter) {
            edges = edges.filter(hop.filter);
            edges = edges.slice(0, limit);
          }

          hopEdges.push(...edges);
        } finally {
          semaphore.release();
        }
      });

      await Promise.all(tasks.map((task) => task()));

      hopResults.push({
        abType: hop.abType,
        depth,
        edges: returnIntermediates ? [...hopEdges] : hopEdges,
        sourceCount,
        truncated: hopTruncated,
      });

      if (hopTruncated) {
        truncated = true;
      }

      const direction = hop.direction ?? 'forward';
      sourceUids = [...new Set(
        hopEdges.map((e) => direction === 'forward' ? e.bUid : e.aUid),
      )];
    }

    const lastHop = hopResults[hopResults.length - 1];

    return {
      nodes: lastHop.edges,
      hops: hopResults,
      totalReads,
      truncated,
    };
  }
}

export function createTraversal(reader: GraphReader, startUid: string): TraversalBuilder {
  return new TraversalBuilderImpl(reader, startUid);
}
