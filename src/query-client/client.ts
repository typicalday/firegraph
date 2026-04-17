import http from 'node:http';

import { readEditorPort } from './config.js';
import { summarizeEdge, summarizeRecord } from './shaping.js';
import type {
  GetEdgesInput,
  GetEdgesResult,
  GetNodeDetailInput,
  GetNodesInput,
  GetNodesResult,
  NodeDetailResult,
  QueryClientOptions,
  SchemaResult,
  SearchInput,
  SearchResult,
  SummarizedEdge,
  SummarizedRecord,
  TraverseHopResult,
  TraverseInput,
  TraverseResult,
} from './types.js';

// --- Error ---

export type QueryClientErrorCode = 'VALIDATION_ERROR' | 'CONNECTION_FAILED' | 'SERVER_ERROR';

export class QueryClientError extends Error {
  constructor(
    message: string,
    public readonly code: QueryClientErrorCode,
  ) {
    super(message);
    this.name = 'QueryClientError';
  }
}

// --- Validation helpers ---

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QueryClientError(`${name} must be a non-empty string`, 'VALIDATION_ERROR');
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value)) {
    throw new QueryClientError(`limit must be an integer`, 'VALIDATION_ERROR');
  }
  return Math.max(min, Math.min(max, value));
}

function validateSortDir(dir: string | undefined): void {
  if (dir != null && dir !== 'asc' && dir !== 'desc') {
    throw new QueryClientError(`sortDir must be 'asc' or 'desc'`, 'VALIDATION_ERROR');
  }
}

// --- HTTP helpers ---

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(body));
      })
      .on('error', (err) => {
        reject(new QueryClientError(`Connection failed: ${err.message}`, 'CONNECTION_FAILED'));
      });
  });
}

function httpPost(url: string, payload: string): Promise<string> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', (err) => {
      reject(new QueryClientError(`Connection failed: ${err.message}`, 'CONNECTION_FAILED'));
    });
    req.write(payload);
    req.end();
  });
}

function parseTrpcResponse(raw: string, procedure: string): unknown {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QueryClientError(
      `Invalid JSON from ${procedure}: ${raw.slice(0, 200)}`,
      'SERVER_ERROR',
    );
  }
  if (parsed.error) {
    const msg =
      typeof parsed.error === 'object' && parsed.error !== null
        ? ((parsed.error as Record<string, unknown>).message ?? JSON.stringify(parsed.error))
        : String(parsed.error);
    throw new QueryClientError(`Server error from ${procedure}: ${msg}`, 'SERVER_ERROR');
  }
  return (parsed.result as Record<string, unknown>)?.data ?? parsed;
}

// --- Client ---

export class QueryClient {
  private readonly baseUrl: string;

  constructor(options?: QueryClientOptions) {
    const host = options?.host ?? 'localhost';
    const port = options?.port ?? readEditorPort();
    this.baseUrl = `http://${host}:${port}/api/trpc`;
  }

  private async query(procedure: string, input?: unknown): Promise<unknown> {
    const qs = input != null ? `?input=${encodeURIComponent(JSON.stringify(input))}` : '';
    const url = `${this.baseUrl}/${procedure}${qs}`;
    const raw = await httpGet(url);
    return parseTrpcResponse(raw, procedure);
  }

  private async mutate(procedure: string, input: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/${procedure}`;
    const raw = await httpPost(url, JSON.stringify(input));
    return parseTrpcResponse(raw, procedure);
  }

  // --- Public API ---

  async getSchema(): Promise<SchemaResult> {
    const data = (await this.query('getSchema')) as Record<string, unknown>;
    return {
      nodeTypes: ((data.nodeTypes as unknown[]) ?? []).map(
        (t) =>
          (typeof t === 'object' && t !== null ? (t as Record<string, unknown>).type : t) as string,
      ),
      edgeTypes: ((data.edgeTypes as unknown[]) ?? []).map((t) => {
        const e = t as Record<string, unknown>;
        return {
          relation: e.axbType as string,
          from: e.aType as string,
          to: e.bType as string,
          inverseLabel: (e.inverseLabel as string) ?? null,
        };
      }),
    };
  }

  async getNodeDetail(input: GetNodeDetailInput): Promise<NodeDetailResult> {
    requireString(input.uid, 'uid');
    const data = (await this.query('getNodeDetail', { uid: input.uid })) as Record<string, unknown>;
    return {
      node: summarizeRecord(data.node as Record<string, unknown> | null),
      outEdges: ((data.outEdges as Record<string, unknown>[]) ?? [])
        .map(summarizeEdge)
        .filter(Boolean) as SummarizedEdge[],
      inEdges: ((data.inEdges as Record<string, unknown>[]) ?? [])
        .map(summarizeEdge)
        .filter(Boolean) as SummarizedEdge[],
    };
  }

  async getNodes(input: GetNodesInput): Promise<GetNodesResult> {
    const limit = clampInt(input.limit, 1, 200, 25);
    validateSortDir(input.sortDir);
    const data = (await this.query('getNodes', {
      type: input.type,
      limit,
      startAfter: input.startAfter,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
      where: input.where,
    })) as Record<string, unknown>;
    return {
      nodes: ((data.nodes as Record<string, unknown>[]) ?? [])
        .map(summarizeRecord)
        .filter(Boolean) as SummarizedRecord[],
      hasMore: (data.hasMore as boolean) ?? false,
      nextCursor: data.nextCursor as string | null | undefined,
    };
  }

  async getEdges(input: GetEdgesInput): Promise<GetEdgesResult> {
    const hasFilter =
      input.aType ||
      input.aUid ||
      input.axbType ||
      input.bType ||
      input.bUid ||
      (input.where && input.where.length > 0);
    if (!hasFilter) {
      throw new QueryClientError(
        'getEdges requires at least one filter field (aType, aUid, axbType, bType, bUid, or where)',
        'VALIDATION_ERROR',
      );
    }
    const limit = clampInt(input.limit, 1, 200, 25);
    validateSortDir(input.sortDir);
    const data = (await this.query('getEdges', {
      aType: input.aType,
      aUid: input.aUid,
      axbType: input.axbType,
      bType: input.bType,
      bUid: input.bUid,
      limit,
      startAfter: input.startAfter,
      sortBy: input.sortBy,
      sortDir: input.sortDir,
      where: input.where,
    })) as Record<string, unknown>;
    return {
      edges: ((data.edges as Record<string, unknown>[]) ?? [])
        .map(summarizeEdge)
        .filter(Boolean) as SummarizedEdge[],
      hasMore: (data.hasMore as boolean) ?? false,
      nextCursor: data.nextCursor as string | null | undefined,
    };
  }

  async traverse(input: TraverseInput): Promise<TraverseResult> {
    requireString(input.startUid, 'startUid');
    if (!input.hops || input.hops.length === 0) {
      throw new QueryClientError('traverse requires at least one hop', 'VALIDATION_ERROR');
    }
    for (let i = 0; i < input.hops.length; i++) {
      const hop = input.hops[i];
      requireString(hop.axbType, `hops[${i}].axbType`);
      if (hop.direction != null && hop.direction !== 'forward' && hop.direction !== 'reverse') {
        throw new QueryClientError(
          `hops[${i}].direction must be 'forward' or 'reverse'`,
          'VALIDATION_ERROR',
        );
      }
      if (hop.limit != null && (!Number.isInteger(hop.limit) || hop.limit < 1)) {
        throw new QueryClientError(
          `hops[${i}].limit must be a positive integer`,
          'VALIDATION_ERROR',
        );
      }
    }
    if (input.maxReads != null && (!Number.isInteger(input.maxReads) || input.maxReads < 1)) {
      throw new QueryClientError('maxReads must be a positive integer', 'VALIDATION_ERROR');
    }
    if (
      input.concurrency != null &&
      (!Number.isInteger(input.concurrency) || input.concurrency < 1)
    ) {
      throw new QueryClientError('concurrency must be a positive integer', 'VALIDATION_ERROR');
    }

    const data = (await this.mutate('traverse', input)) as Record<string, unknown>;
    return {
      hops: ((data.hops as Record<string, unknown>[]) ?? []).map(
        (h): TraverseHopResult => ({
          relation: h.axbType as string,
          direction: h.direction as string,
          depth: h.depth as number,
          edgeCount: ((h.edges as unknown[]) ?? []).length,
          edges: ((h.edges as Record<string, unknown>[]) ?? [])
            .map(summarizeEdge)
            .filter(Boolean) as SummarizedEdge[],
          truncated: (h.truncated as boolean) ?? false,
        }),
      ),
      totalReads: (data.totalReads as number) ?? 0,
      truncated: (data.truncated as boolean) ?? false,
    };
  }

  async search(input: SearchInput): Promise<SearchResult> {
    requireString(input.q, 'q');
    const limit = clampInt(input.limit, 1, 50, 20);
    const data = (await this.query('search', { q: input.q, limit })) as Record<string, unknown>;
    return {
      results: ((data.results as Record<string, unknown>[]) ?? [])
        .map((r) => {
          const base = summarizeRecord(r);
          if (!base) return null;
          return {
            ...base,
            matchType: (r._matchType as string) ?? null,
          };
        })
        .filter(Boolean) as (SummarizedRecord & { matchType: string | null })[],
    };
  }
}
