import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { QueryClient, QueryClientError } from '../../../src/query-client/client.js';

// Mock config to avoid filesystem reads
vi.mock('../../../src/query-client/config.js', () => ({
  readEditorPort: () => 3884,
}));

// --- HTTP mock helpers ---

function createMockResponse(body: string): EventEmitter & { statusCode: number } {
  const res = new EventEmitter() as EventEmitter & { statusCode: number };
  res.statusCode = 200;
  process.nextTick(() => {
    res.emit('data', body);
    res.emit('end');
  });
  return res;
}

function createMockRequest(): EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } {
  const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  req.write = vi.fn();
  req.end = vi.fn();
  return req;
}

let httpGetSpy: ReturnType<typeof vi.spyOn>;
let httpRequestSpy: ReturnType<typeof vi.spyOn>;
let lastMockRequest: ReturnType<typeof createMockRequest> | null = null;

beforeEach(() => {
  httpGetSpy = vi.spyOn(http, 'get');
  httpRequestSpy = vi.spyOn(http, 'request');
  lastMockRequest = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGetResponse(data: unknown): void {
  const body = JSON.stringify({ result: { data } });
  httpGetSpy.mockImplementation((_url: unknown, cb: unknown) => {
    const res = createMockResponse(body);
    (cb as (r: unknown) => void)(res);
    const req = new EventEmitter();
    return req as ReturnType<typeof http.get>;
  });
}

function mockPostResponse(data: unknown): void {
  const body = JSON.stringify({ result: { data } });
  httpRequestSpy.mockImplementation((_opts: unknown, cb: unknown) => {
    const res = createMockResponse(body);
    (cb as (r: unknown) => void)(res);
    lastMockRequest = createMockRequest();
    return lastMockRequest as unknown as http.ClientRequest;
  });
}

/** Extract the input object sent via GET query string */
function getQueryInput(callIndex = 0): Record<string, unknown> {
  const url = httpGetSpy.mock.calls[callIndex][0] as string;
  const inputParam = url.split('input=')[1];
  return JSON.parse(decodeURIComponent(inputParam));
}

describe('QueryClient', () => {
  describe('getSchema', () => {
    it('transforms server nodeTypes objects to string array', async () => {
      mockGetResponse({
        nodeTypes: [{ type: 'task' }, { type: 'user' }],
        edgeTypes: [],
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.getSchema();

      expect(result.nodeTypes).toEqual(['task', 'user']);
    });

    it('transforms server edgeTypes to renamed fields', async () => {
      mockGetResponse({
        nodeTypes: [],
        edgeTypes: [
          { aType: 'user', axbType: 'hasTask', bType: 'task', inverseLabel: 'taskOf' },
          { aType: 'task', axbType: 'hasStep', bType: 'step' },
        ],
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.getSchema();

      expect(result.edgeTypes).toEqual([
        { relation: 'hasTask', from: 'user', to: 'task', inverseLabel: 'taskOf' },
        { relation: 'hasStep', from: 'task', to: 'step', inverseLabel: null },
      ]);
    });

    it('builds correct URL with host and port', async () => {
      mockGetResponse({ nodeTypes: [], edgeTypes: [] });
      const client = new QueryClient({ port: 5000, host: 'example.com' });
      await client.getSchema();

      const calledUrl = httpGetSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('http://example.com:5000/api/trpc/getSchema');
    });

    it('omits query string when no input', async () => {
      mockGetResponse({ nodeTypes: [], edgeTypes: [] });
      const client = new QueryClient({ port: 3884 });
      await client.getSchema();

      const calledUrl = httpGetSpy.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('?');
    });

    it('handles empty arrays from server', async () => {
      mockGetResponse({ nodeTypes: [], edgeTypes: [] });
      const client = new QueryClient({ port: 3884 });
      const result = await client.getSchema();

      expect(result.nodeTypes).toEqual([]);
      expect(result.edgeTypes).toEqual([]);
    });
  });

  describe('getNodeDetail', () => {
    it('rejects empty uid', async () => {
      const client = new QueryClient({ port: 3884 });
      await expect(client.getNodeDetail({ uid: '' })).rejects.toThrow(QueryClientError);
      await expect(client.getNodeDetail({ uid: '' })).rejects.toThrow('uid must be a non-empty string');
    });

    it('summarizes node and edges from server response', async () => {
      mockGetResponse({
        node: { aType: 'task', aUid: 'task1', data: { title: 'Test' } },
        outEdges: [
          { aType: 'task', aUid: 'task1', axbType: 'hasStep', bType: 'step', bUid: 'step1', data: { order: 1 } },
        ],
        inEdges: [
          { aType: 'user', aUid: 'u1', axbType: 'assigned', bType: 'task', bUid: 'task1', data: {} },
        ],
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.getNodeDetail({ uid: 'task1' });

      expect(result.node).toEqual({ type: 'task', uid: 'task1', data: { title: 'Test' } });
      expect(result.outEdges).toEqual([
        { from: 'task:task1', relation: 'hasStep', to: 'step:step1', data: { order: 1 } },
      ]);
      // Edge with empty data should omit data field
      expect(result.inEdges).toEqual([
        { from: 'user:u1', relation: 'assigned', to: 'task:task1' },
      ]);
      expect(result.inEdges[0]).not.toHaveProperty('data');
    });

    it('handles node not found (null node)', async () => {
      mockGetResponse({ node: null, outEdges: [], inEdges: [] });
      const client = new QueryClient({ port: 3884 });
      const result = await client.getNodeDetail({ uid: 'missing' });

      expect(result.node).toBeNull();
      expect(result.outEdges).toEqual([]);
      expect(result.inEdges).toEqual([]);
    });

    it('encodes input with special characters in query string', async () => {
      mockGetResponse({ node: null, outEdges: [], inEdges: [] });
      const client = new QueryClient({ port: 3884 });
      await client.getNodeDetail({ uid: 'test:uid/with spaces' });

      const calledUrl = httpGetSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('getNodeDetail');
      expect(calledUrl).toContain(encodeURIComponent(JSON.stringify({ uid: 'test:uid/with spaces' })));
    });
  });

  describe('getNodes', () => {
    it('summarizes nodes from server response', async () => {
      mockGetResponse({
        nodes: [
          { aType: 'task', aUid: 't1', data: { title: 'A' } },
          { aType: 'task', aUid: 't2', data: {} },
        ],
        hasMore: true,
        nextCursor: 't2',
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.getNodes({ type: 'task' });

      expect(result.nodes).toEqual([
        { type: 'task', uid: 't1', data: { title: 'A' } },
        { type: 'task', uid: 't2' }, // empty data omitted
      ]);
      expect(result.nodes[1]).not.toHaveProperty('data');
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe('t2');
    });

    it('clamps limit above 200 down to 200', async () => {
      mockGetResponse({ nodes: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      await client.getNodes({ type: 'task', limit: 500 });

      expect(getQueryInput().limit).toBe(200);
    });

    it('clamps limit below 1 up to 1', async () => {
      mockGetResponse({ nodes: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      await client.getNodes({ type: 'task', limit: 0 });

      expect(getQueryInput().limit).toBe(1);
    });

    it('defaults limit to 25 when not provided', async () => {
      mockGetResponse({ nodes: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      await client.getNodes({ type: 'task' });

      expect(getQueryInput().limit).toBe(25);
    });

    it('rejects float limit', async () => {
      const client = new QueryClient({ port: 3884 });
      await expect(
        client.getNodes({ type: 'task', limit: 3.5 }),
      ).rejects.toThrow('limit must be an integer');
    });

    it('rejects invalid sortDir', async () => {
      const client = new QueryClient({ port: 3884 });
      await expect(
        client.getNodes({ type: 'task', sortDir: 'up' as 'asc' }),
      ).rejects.toThrow("sortDir must be 'asc' or 'desc'");
    });

    it('passes through sortBy and sortDir to the wire', async () => {
      mockGetResponse({ nodes: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      await client.getNodes({ type: 'task', sortBy: 'data.title', sortDir: 'desc' });

      const input = getQueryInput();
      expect(input.sortBy).toBe('data.title');
      expect(input.sortDir).toBe('desc');
    });
  });

  describe('getEdges', () => {
    it('requires at least one filter', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.getEdges({}).catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('at least one filter');
    });

    it('summarizes edges from server response', async () => {
      mockGetResponse({
        edges: [
          { aType: 'user', aUid: 'u1', axbType: 'hasTask', bType: 'task', bUid: 't1', data: { role: 'owner' } },
          { aType: 'user', aUid: 'u1', axbType: 'hasTask', bType: 'task', bUid: 't2', data: {} },
        ],
        hasMore: false,
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.getEdges({ aUid: 'u1' });

      expect(result.edges).toEqual([
        { from: 'user:u1', relation: 'hasTask', to: 'task:t1', data: { role: 'owner' } },
        { from: 'user:u1', relation: 'hasTask', to: 'task:t2' },
      ]);
      expect(result.edges[1]).not.toHaveProperty('data');
      expect(result.hasMore).toBe(false);
    });

    it('sends all filter fields over the wire', async () => {
      mockGetResponse({ edges: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      await client.getEdges({ aType: 'user', aUid: 'u1', axbType: 'hasTask', bType: 'task', bUid: 't1' });

      const input = getQueryInput();
      expect(input.aType).toBe('user');
      expect(input.aUid).toBe('u1');
      expect(input.axbType).toBe('hasTask');
      expect(input.bType).toBe('task');
      expect(input.bUid).toBe('t1');
    });

    it('accepts where clause as sole filter', async () => {
      mockGetResponse({ edges: [], hasMore: false });
      const client = new QueryClient({ port: 3884 });
      const result = await client.getEdges({ where: [{ field: 'data.x', op: '==', value: 1 }] });

      expect(result.edges).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('rejects empty where array as no filter', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.getEdges({ where: [] }).catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('traverse', () => {
    it('rejects empty startUid', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.traverse({ startUid: '', hops: [{ axbType: 'x' }] }).catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('startUid');
    });

    it('rejects empty hops array', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.traverse({ startUid: 'a', hops: [] }).catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.message).toContain('at least one hop');
    });

    it('rejects hop with empty axbType', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.traverse({ startUid: 'a', hops: [{ axbType: '' }] }).catch((e: QueryClientError) => e);
      expect(err.message).toContain('hops[0].axbType');
    });

    it('rejects invalid direction', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'a', hops: [{ axbType: 'rel', direction: 'sideways' as 'forward' }] })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain("'forward' or 'reverse'");
    });

    it('rejects zero hop limit', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'a', hops: [{ axbType: 'rel', limit: 0 }] })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain('limit must be a positive integer');
    });

    it('rejects fractional hop limit', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'a', hops: [{ axbType: 'rel', limit: 2.5 }] })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain('limit must be a positive integer');
    });

    it('rejects negative maxReads', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'a', hops: [{ axbType: 'rel' }], maxReads: -1 })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain('maxReads');
    });

    it('rejects zero concurrency', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'a', hops: [{ axbType: 'rel' }], concurrency: 0 })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain('concurrency');
    });

    it('validates all hops, not just the first', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({
          startUid: 'a',
          hops: [
            { axbType: 'rel1' },
            { axbType: '' }, // second hop is invalid
          ],
        })
        .catch((e: QueryClientError) => e);
      expect(err.message).toContain('hops[1].axbType');
    });

    it('sends POST with correct body and summarizes response', async () => {
      mockPostResponse({
        hops: [
          {
            axbType: 'hasTask',
            direction: 'forward',
            depth: 1,
            edges: [
              { aType: 'user', aUid: 'u1', axbType: 'hasTask', bType: 'task', bUid: 't1', data: { priority: 'high' } },
              { aType: 'user', aUid: 'u1', axbType: 'hasTask', bType: 'task', bUid: 't2', data: {} },
            ],
            truncated: false,
          },
        ],
        totalReads: 2,
        truncated: false,
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.traverse({
        startUid: 'u1',
        hops: [{ axbType: 'hasTask', direction: 'forward', limit: 10 }],
        maxReads: 50,
      });

      // Verify POST was used
      expect(httpRequestSpy).toHaveBeenCalled();
      const opts = httpRequestSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(opts.method).toBe('POST');

      // Verify request body
      const writtenBody = lastMockRequest!.write.mock.calls[0][0] as string;
      const sentInput = JSON.parse(writtenBody);
      expect(sentInput.startUid).toBe('u1');
      expect(sentInput.hops[0].axbType).toBe('hasTask');
      expect(sentInput.hops[0].direction).toBe('forward');
      expect(sentInput.hops[0].limit).toBe(10);
      expect(sentInput.maxReads).toBe(50);

      // Verify response shaping
      expect(result.hops).toHaveLength(1);
      expect(result.hops[0].relation).toBe('hasTask');
      expect(result.hops[0].direction).toBe('forward');
      expect(result.hops[0].depth).toBe(1);
      expect(result.hops[0].edgeCount).toBe(2);
      expect(result.hops[0].edges[0]).toEqual({
        from: 'user:u1', relation: 'hasTask', to: 'task:t1', data: { priority: 'high' },
      });
      // Empty data omitted
      expect(result.hops[0].edges[1]).toEqual({
        from: 'user:u1', relation: 'hasTask', to: 'task:t2',
      });
      expect(result.hops[0].edges[1]).not.toHaveProperty('data');
      expect(result.hops[0].truncated).toBe(false);
      expect(result.totalReads).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it('allows valid input to pass through to server', async () => {
      mockPostResponse({ hops: [], totalReads: 0, truncated: false });
      const client = new QueryClient({ port: 3884 });

      // This should NOT throw — valid forward, valid reverse, with all optional fields
      const result = await client.traverse({
        startUid: 'x',
        hops: [
          { axbType: 'rel1', direction: 'forward', limit: 5 },
          { axbType: 'rel2', direction: 'reverse', limit: 20, aType: 'a', bType: 'b' },
        ],
        maxReads: 200,
        concurrency: 10,
      });

      expect(result.hops).toEqual([]);
    });
  });

  describe('search', () => {
    it('rejects empty query string', async () => {
      const client = new QueryClient({ port: 3884 });
      const err = await client.search({ q: '' }).catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('q must be a non-empty string');
    });

    it('clamps limit above 50 to 50', async () => {
      mockGetResponse({ results: [] });
      const client = new QueryClient({ port: 3884 });
      await client.search({ q: 'test', limit: 100 });

      expect(getQueryInput().limit).toBe(50);
    });

    it('defaults limit to 20', async () => {
      mockGetResponse({ results: [] });
      const client = new QueryClient({ port: 3884 });
      await client.search({ q: 'test' });

      expect(getQueryInput().limit).toBe(20);
    });

    it('summarizes results and maps matchType', async () => {
      mockGetResponse({
        results: [
          { aType: 'user', aUid: 'u1', data: { name: 'John' }, _matchType: 'uid' },
          { aType: 'task', aUid: 't1', data: {}, _matchType: 'data' },
        ],
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.search({ q: 'john' });

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({
        type: 'user', uid: 'u1', data: { name: 'John' }, matchType: 'uid',
      });
      // empty data omitted, matchType mapped
      expect(result.results[1]).toEqual({
        type: 'task', uid: 't1', matchType: 'data',
      });
      expect(result.results[1]).not.toHaveProperty('data');
    });

    it('defaults matchType to null when _matchType missing', async () => {
      mockGetResponse({
        results: [{ aType: 'user', aUid: 'u1', data: { name: 'X' } }],
      });

      const client = new QueryClient({ port: 3884 });
      const result = await client.search({ q: 'X' });

      expect(result.results[0].matchType).toBeNull();
    });
  });

  describe('error handling', () => {
    it('wraps connection refused as CONNECTION_FAILED', async () => {
      httpGetSpy.mockImplementation((_url: unknown, _cb: unknown) => {
        const req = new EventEmitter();
        process.nextTick(() => req.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:3884')));
        return req as ReturnType<typeof http.get>;
      });

      const client = new QueryClient({ port: 3884 });
      const err = await client.getSchema().catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('CONNECTION_FAILED');
      expect(err.message).toContain('ECONNREFUSED');
    });

    it('wraps POST connection error as CONNECTION_FAILED', async () => {
      httpRequestSpy.mockImplementation((_opts: unknown, _cb: unknown) => {
        const req = createMockRequest();
        process.nextTick(() => (req as EventEmitter).emit('error', new Error('ECONNRESET')));
        return req as unknown as http.ClientRequest;
      });

      const client = new QueryClient({ port: 3884 });
      const err = await client
        .traverse({ startUid: 'x', hops: [{ axbType: 'rel' }] })
        .catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('CONNECTION_FAILED');
    });

    it('wraps invalid JSON response as SERVER_ERROR', async () => {
      httpGetSpy.mockImplementation((_url: unknown, cb: unknown) => {
        const res = createMockResponse('not json at all');
        (cb as (r: unknown) => void)(res);
        return new EventEmitter() as ReturnType<typeof http.get>;
      });

      const client = new QueryClient({ port: 3884 });
      const err = await client.getSchema().catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.message).toContain('Invalid JSON');
    });

    it('extracts message from tRPC error responses', async () => {
      httpGetSpy.mockImplementation((_url: unknown, cb: unknown) => {
        const body = JSON.stringify({ error: { message: 'Collection not found' } });
        const res = createMockResponse(body);
        (cb as (r: unknown) => void)(res);
        return new EventEmitter() as ReturnType<typeof http.get>;
      });

      const client = new QueryClient({ port: 3884 });
      const err = await client.getSchema().catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.message).toBe('Server error from getSchema: Collection not found');
    });

    it('handles tRPC error without message field', async () => {
      httpGetSpy.mockImplementation((_url: unknown, cb: unknown) => {
        const body = JSON.stringify({ error: { code: 'NOT_FOUND' } });
        const res = createMockResponse(body);
        (cb as (r: unknown) => void)(res);
        return new EventEmitter() as ReturnType<typeof http.get>;
      });

      const client = new QueryClient({ port: 3884 });
      const err = await client.getSchema().catch((e: QueryClientError) => e);
      expect(err).toBeInstanceOf(QueryClientError);
      expect(err.code).toBe('SERVER_ERROR');
      // Should JSON.stringify the error object when no message field
      expect(err.message).toContain('NOT_FOUND');
    });
  });

  describe('QueryClientError', () => {
    it('has correct name, code, message and extends Error', () => {
      const err = new QueryClientError('something broke', 'SERVER_ERROR');
      expect(err.name).toBe('QueryClientError');
      expect(err.code).toBe('SERVER_ERROR');
      expect(err.message).toBe('something broke');
      expect(err).toBeInstanceOf(Error);
      expect(err.stack).toBeDefined();
    });
  });
});
