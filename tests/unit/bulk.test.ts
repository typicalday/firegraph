import { describe, it, expect, vi } from 'vitest';
import { bulkDeleteDocIds, bulkRemoveEdges, removeNodeCascade } from '../../src/bulk.js';
import type { GraphReader, StoredGraphRecord, FindEdgesParams, BulkProgress } from '../../src/types.js';

function makeRecord(overrides: Partial<StoredGraphRecord>): StoredGraphRecord {
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

/** Creates a mock Firestore with a controllable batch. */
function createMockFirestore(commitImpl?: () => Promise<void>) {
  const deletedDocIds: string[] = [];
  const commitFn = vi.fn(commitImpl ?? (async () => {}));

  const db = {
    batch: vi.fn(() => ({
      delete: vi.fn((docRef: any) => {
        deletedDocIds.push(docRef._id);
      }),
      commit: commitFn,
    })),
    collection: vi.fn((path: string) => ({
      doc: (id: string) => ({ _id: id }),
    })),
  } as any;

  return { db, deletedDocIds, commitFn };
}

describe('bulkDeleteDocIds', () => {
  it('returns zero result for empty input', async () => {
    const { db } = createMockFirestore();
    const result = await bulkDeleteDocIds(db, 'col', []);
    expect(result).toEqual({ deleted: 0, batches: 0, errors: [] });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('deletes all doc IDs in a single batch when under limit', async () => {
    const { db, deletedDocIds } = createMockFirestore();
    const ids = ['doc1', 'doc2', 'doc3'];

    const result = await bulkDeleteDocIds(db, 'col', ids);

    expect(result.deleted).toBe(3);
    expect(result.batches).toBe(1);
    expect(result.errors).toEqual([]);
    expect(deletedDocIds).toEqual(['doc1', 'doc2', 'doc3']);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('splits into multiple batches based on batchSize', async () => {
    const { db } = createMockFirestore();
    const ids = Array.from({ length: 7 }, (_, i) => `doc${i}`);

    const result = await bulkDeleteDocIds(db, 'col', ids, { batchSize: 3 });

    expect(result.deleted).toBe(7);
    // 7 docs / 3 per batch = 3 batches (3 + 3 + 1)
    expect(result.batches).toBe(3);
    expect(db.batch).toHaveBeenCalledTimes(3);
  });

  it('caps batchSize at 500 even if higher value is passed', async () => {
    const { db } = createMockFirestore();
    const ids = Array.from({ length: 3 }, (_, i) => `doc${i}`);

    const result = await bulkDeleteDocIds(db, 'col', ids, { batchSize: 9999 });

    // Should use a single batch (capped at 500, and we only have 3 docs)
    expect(result.batches).toBe(1);
  });

  it('calls onProgress after each batch', async () => {
    const { db } = createMockFirestore();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const progressCalls: BulkProgress[] = [];

    await bulkDeleteDocIds(db, 'col', ids, {
      batchSize: 2,
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    expect(progressCalls).toEqual([
      { completedBatches: 1, totalBatches: 3, deletedSoFar: 2 },
      { completedBatches: 2, totalBatches: 3, deletedSoFar: 4 },
      { completedBatches: 3, totalBatches: 3, deletedSoFar: 5 },
    ]);
  });

  it('retries failed batches with exponential backoff', async () => {
    let callCount = 0;
    const { db } = createMockFirestore(async () => {
      callCount++;
      // Fail on the first two attempts, succeed on the third
      if (callCount <= 2) throw new Error('transient');
    });

    const result = await bulkDeleteDocIds(db, 'col', ['doc1'], {
      maxRetries: 3,
    });

    expect(result.deleted).toBe(1);
    expect(result.errors).toEqual([]);
    // 1 initial + 2 retries = 3 commit calls
    expect(callCount).toBe(3);
  });

  it('records error after exhausting retries', async () => {
    const { db } = createMockFirestore(async () => {
      throw new Error('persistent failure');
    });

    const result = await bulkDeleteDocIds(db, 'col', ['doc1', 'doc2'], {
      maxRetries: 1,
      batchSize: 2,
    });

    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].batchIndex).toBe(0);
    expect(result.errors[0].operationCount).toBe(2);
    expect(result.errors[0].error.message).toBe('persistent failure');
  });

  it('continues with remaining batches after one fails', async () => {
    let batchNum = 0;
    const { db } = createMockFirestore(async () => {
      batchNum++;
      // Fail the first batch, succeed the second
      if (batchNum <= 2) throw new Error('fail batch 1');
    });

    const result = await bulkDeleteDocIds(db, 'col', ['a', 'b', 'c'], {
      batchSize: 2,
      maxRetries: 1,
    });

    // First batch (a, b) failed after 1 retry (2 attempts)
    // Second batch (c) succeeded
    expect(result.deleted).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].batchIndex).toBe(0);
    expect(result.errors[0].operationCount).toBe(2);
  });
});

describe('bulkRemoveEdges', () => {
  it('queries edges then deletes their doc IDs', async () => {
    const edges = [
      makeRecord({ aUid: 'n1', axbType: 'hasX', bUid: 'x1' }),
      makeRecord({ aUid: 'n1', axbType: 'hasX', bUid: 'x2' }),
    ];
    const reader = createMockReader(async () => edges);
    const { db } = createMockFirestore();

    const result = await bulkRemoveEdges(db, 'col', reader, { aUid: 'n1', axbType: 'hasX' });

    expect(result.deleted).toBe(2);
    expect(reader.findEdges).toHaveBeenCalledWith({ aUid: 'n1', axbType: 'hasX' });
  });

  it('returns zero when no edges match', async () => {
    const reader = createMockReader(async () => []);
    const { db } = createMockFirestore();

    const result = await bulkRemoveEdges(db, 'col', reader, { aUid: 'x', axbType: 'y' });

    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(0);
  });
});

describe('removeNodeCascade', () => {
  it('queries outgoing and incoming edges in parallel', async () => {
    const reader = createMockReader(async () => []);
    const { db } = createMockFirestore();

    await removeNodeCascade(db, 'col', reader, 'node1');

    expect(reader.findEdges).toHaveBeenCalledTimes(2);
    expect(reader.findEdges).toHaveBeenCalledWith({ aUid: 'node1' });
    expect(reader.findEdges).toHaveBeenCalledWith({ bUid: 'node1' });
  });

  it('filters out self-loop (is) records from edge queries', async () => {
    const reader = createMockReader(async (params) => {
      if (params.aUid === 'node1') {
        return [
          // Self-loop node record — should be excluded
          makeRecord({ aUid: 'node1', axbType: 'is', bUid: 'node1', aType: 'task', bType: 'task' }),
          // Real edge — should be included
          makeRecord({ aUid: 'node1', axbType: 'hasChild', bUid: 'child1' }),
        ];
      }
      return [];
    });
    const { db, deletedDocIds } = createMockFirestore();

    const result = await removeNodeCascade(db, 'col', reader, 'node1');

    expect(result.edgesDeleted).toBe(1);
    expect(result.nodeDeleted).toBe(true);
    // Should have 2 doc IDs: the hasChild edge + the node doc
    expect(deletedDocIds).toHaveLength(2);
  });

  it('deduplicates self-referencing edges that appear in both queries', async () => {
    // A self-referencing edge (node1 -> node1) appears in both outgoing and incoming
    const selfEdge = makeRecord({ aUid: 'node1', axbType: 'linksTo', bUid: 'node1' });

    const reader = createMockReader(async (params) => {
      if (params.aUid === 'node1') return [selfEdge];
      if (params.bUid === 'node1') return [selfEdge];
      return [];
    });
    const { db, deletedDocIds } = createMockFirestore();

    const result = await removeNodeCascade(db, 'col', reader, 'node1');

    expect(result.edgesDeleted).toBe(1);
    // 1 edge + 1 node = 2 deletes, not 3
    expect(deletedDocIds).toHaveLength(2);
  });

  it('reports nodeDeleted=false when the last batch fails', async () => {
    const edges = Array.from({ length: 3 }, (_, i) =>
      makeRecord({ aUid: 'n1', axbType: 'rel', bUid: `b${i}` }),
    );
    const reader = createMockReader(async (params) => {
      if (params.aUid) return edges;
      return [];
    });

    // batchSize=2: batch 1 = [edge0, edge1], batch 2 = [edge2, nodeDoc]
    // We need a shared counter across all batch().commit() calls.
    let commitCount = 0;
    const deletedDocIds: string[] = [];
    const db = {
      batch: vi.fn(() => ({
        delete: vi.fn((docRef: any) => {
          deletedDocIds.push(docRef._id);
        }),
        commit: vi.fn(async () => {
          commitCount++;
          // Fail on the 2nd batch (and its retry)
          if (commitCount >= 2) throw new Error('fail');
        }),
      })),
      collection: vi.fn(() => ({
        doc: (id: string) => ({ _id: id }),
      })),
    } as any;

    const result = await removeNodeCascade(db, 'col', reader, 'n1', {
      batchSize: 2,
      maxRetries: 1,
    });

    expect(result.nodeDeleted).toBe(false);
    expect(result.edgesDeleted).toBe(2); // first batch succeeded
    expect(result.errors).toHaveLength(1);
  });
});
