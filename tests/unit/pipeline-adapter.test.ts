import { describe, expect, it } from 'vitest';

import { createPipelineQueryAdapter } from '../../src/firestore-enterprise/pipeline-adapter.js';

/**
 * Creates a mock Firestore instance with a chainable pipeline() method.
 * Tracks which operations are called and in what order.
 */
function createMockDb() {
  const calls: { method: string; args: unknown[] }[] = [];
  const resultData = [
    {
      aType: 'tour',
      aUid: 'u1',
      axbType: 'is',
      bType: 'tour',
      bUid: 'u1',
      data: { name: 'Tour A' },
    },
    {
      aType: 'tour',
      aUid: 'u2',
      axbType: 'is',
      bType: 'tour',
      bUid: 'u2',
      data: { name: 'Tour B' },
    },
  ];

  const pipelineObj = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'execute') {
          return async () => ({
            results: resultData.map((d) => ({ data: () => d })),
          });
        }
        // All other methods return the chain for fluent chaining
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return pipelineObj;
        };
      },
    },
  );

  const db = {
    pipeline: () => pipelineObj,
  } as any;

  return { db, calls, resultData };
}

describe('createPipelineQueryAdapter', () => {
  it('executes a pipeline query with a single filter', async () => {
    const { db, calls, resultData } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    const results = await adapter.query([{ field: 'axbType', op: '==', value: 'is' }]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(resultData[0]);
    expect(results[1]).toEqual(resultData[1]);

    // Should have: collection, where
    expect(calls[0].method).toBe('collection');
    expect(calls[0].args[0]).toBe('graph');
    expect(calls[1].method).toBe('where');
  });

  it('executes a pipeline query with multiple filters (AND)', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'my/collection');

    await adapter.query([
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'aType', op: '==', value: 'tour' },
    ]);

    expect(calls[0].method).toBe('collection');
    expect(calls[0].args[0]).toBe('my/collection');
    expect(calls[1].method).toBe('where');
    // The where arg should be an AND expression (we can't inspect internal types,
    // but we verify it's called with a single arg which is the and() result)
    expect(calls[1].args).toHaveLength(1);
  });

  it('applies sort when orderBy is provided', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([{ field: 'axbType', op: '==', value: 'is' }], {
      orderBy: { field: 'data.name', direction: 'asc' },
    });

    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain('sort');
  });

  it('applies limit when provided', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([{ field: 'axbType', op: '==', value: 'is' }], { limit: 10 });

    const limitCall = calls.find((c) => c.method === 'limit');
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBe(10);
  });

  it('applies sort + limit together', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([{ field: 'axbType', op: '==', value: 'is' }], {
      orderBy: { field: 'data.price', direction: 'desc' },
      limit: 5,
    });

    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain('sort');
    expect(methodNames).toContain('limit');
    // sort should come before limit
    expect(methodNames.indexOf('sort')).toBeLessThan(methodNames.indexOf('limit'));
  });

  it('handles inequality operators', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([
      { field: 'axbType', op: '==', value: 'is' },
      { field: 'data.price', op: '>', value: 3000 },
      { field: 'data.price', op: '<=', value: 10000 },
    ]);

    // Should still produce a single where() call with and()
    expect(calls[1].method).toBe('where');
    expect(calls[1].args).toHaveLength(1);
  });

  it('returns empty array when pipeline returns no results', async () => {
    const db = {
      pipeline: () => {
        const chain: any = {};
        const proxy = new Proxy(chain, {
          get(_target, prop: string) {
            if (prop === 'execute') {
              return async () => ({ results: [] });
            }
            return () => proxy;
          },
        });
        return proxy;
      },
    } as any;

    const adapter = createPipelineQueryAdapter(db, 'graph');
    const results = await adapter.query([{ field: 'axbType', op: '==', value: 'nonexistent' }]);

    expect(results).toEqual([]);
  });

  it('handles no filters (empty array)', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    const results = await adapter.query([]);

    // Should have collection but no where
    expect(calls[0].method).toBe('collection');
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).not.toContain('where');
    expect(results).toHaveLength(2);
  });

  it('handles desc sort direction', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([{ field: 'axbType', op: '==', value: 'is' }], {
      orderBy: { field: 'data.price', direction: 'desc' },
    });

    expect(calls.find((c) => c.method === 'sort')).toBeDefined();
  });

  it('defaults to ascending sort when no direction specified', async () => {
    const { db, calls } = createMockDb();
    const adapter = createPipelineQueryAdapter(db, 'graph');

    await adapter.query([{ field: 'axbType', op: '==', value: 'is' }], {
      orderBy: { field: 'data.name' },
    });

    expect(calls.find((c) => c.method === 'sort')).toBeDefined();
  });
});
