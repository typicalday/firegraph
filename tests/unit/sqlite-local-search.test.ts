/**
 * Tests for the `firegraph/sqlite-local` search capabilities:
 * `search.fullText` (FTS5 index synced by pure-SQL triggers) and
 * `search.vector` (brute-force scan scored by a connection-local UDF).
 *
 * These run against real better-sqlite3 databases (mostly `:memory:`,
 * on-disk where multi-connection or persistence behaviour is the point)
 * through the full client surface, so they also pin scan-protection and
 * the capability-typed method exposure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/client.js';
import { generateId } from '../../src/id.js';
import { generateIndexConfig } from '../../src/indexes.js';
import {
  buildFtsDDL,
  buildFtsSyncStatements,
  buildLocalSearchDDL,
  computeVectorDistance,
  findOrphanedFtsTables,
  ftsCfgTableName,
  ftsMapTableName,
  ftsTableName,
  isFts5QueryError,
  perTypeFtsTableName,
  sharedFtsTriggerDefs,
} from '../../src/internal/sqlite-search.js';
import { createRegistry } from '../../src/registry.js';
import { createSqliteBackend } from '../../src/sqlite/backend.js';
import { tableForScope } from '../../src/sqlite/catalog.js';
import { createBetterSqliteExecutor, createLocalSqliteBackend } from '../../src/sqlite/local.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'firegraph-sqlite-local-search-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  return join(dir, `${name}.db`);
}

async function memoryClient() {
  const local = await createLocalSqliteBackend(':memory:');
  return { client: createGraphClient(local.backend), ...local };
}

describe('capability surface', () => {
  it('declares search.fullText and search.vector on top of the shared set', async () => {
    const { backend, close } = await createLocalSqliteBackend(':memory:');
    const caps = new Set(backend.capabilities.values());
    for (const cap of [
      'core.read',
      'core.write',
      'core.transactions',
      'core.batch',
      'core.subgraph',
      'query.aggregate',
      'query.select',
      'query.join',
      'query.dml',
      'raw.sql',
      'search.fullText',
      'search.vector',
    ]) {
      expect(caps.has(cap as never), cap).toBe(true);
    }
    expect(caps.has('search.geo' as never)).toBe(false);
    expect(typeof backend.fullTextSearch).toBe('function');
    expect(typeof backend.findNearest).toBe('function');
    // Routing invariant: optional methods the inner backend omits must be
    // absent on the wrapper too — not present-but-undefined.
    expect('findEdgesGlobal' in backend).toBe(false);
    close();
  });

  it('subgraph backends carry the search capabilities', async () => {
    const { backend, close } = await createLocalSqliteBackend(':memory:');
    const child = backend.subgraph(generateId(), 'inventory');
    const caps = new Set(child.capabilities.values());
    expect(caps.has('search.fullText' as never)).toBe(true);
    expect(caps.has('search.vector' as never)).toBe(true);
    close();
  });
});

describe('fullTextSearch', () => {
  it('matches text anywhere in the data payload and ranks by bm25', async () => {
    const { client, close } = await memoryClient();
    const alps = generateId();
    const andes = generateId();
    const sea = generateId();
    await client.putNode('tour', alps, {
      name: 'Alpine hiking',
      description: 'hiking and more hiking across alpine hiking trails',
    });
    await client.putNode('tour', andes, {
      name: 'Andes trek',
      details: { note: 'one mention of hiking here' },
    });
    await client.putNode('tour', sea, { name: 'Sea kayaking', description: 'paddles only' });

    const results = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'hiking',
      limit: 10,
    });
    expect(results.map((r) => r.aUid)).toEqual([alps, andes]);
    // Nested string values are indexed (json_tree walks the whole payload).
    expect(results[1].data).toEqual({
      name: 'Andes trek',
      details: { note: 'one mention of hiking here' },
    });
    close();
  });

  it('stays in sync through update, replace, delete, batch, and transaction writes', async () => {
    const { client, close } = await memoryClient();
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'glacier walk' });
    const hit = async (q: string) =>
      (await client.fullTextSearch({ aType: 'tour', axbType: 'is', query: q, limit: 5 })).length;

    expect(await hit('glacier')).toBe(1);

    // Deep-merge update rewrites the index from the merged payload.
    await client.updateNode(uid, { name: 'volcano walk' });
    expect(await hit('glacier')).toBe(0);
    expect(await hit('volcano')).toBe(1);

    // Replace (wipe-and-rewrite) too.
    await client.replaceNode('tour', uid, { name: 'desert ride' });
    expect(await hit('volcano')).toBe(0);
    expect(await hit('desert')).toBe(1);

    // Batch writes go through the same triggers.
    const batchUid = generateId();
    const batch = client.batch();
    batch.putNode('tour', batchUid, { name: 'batched canyon' });
    await batch.commit();
    expect(await hit('canyon')).toBe(1);

    // Transaction writes too.
    const txUid = generateId();
    await client.runTransaction(async (tx) => {
      await tx.putNode('tour', txUid, { name: 'transactional fjord' });
    });
    expect(await hit('fjord')).toBe(1);

    // Deletes drop the index entry.
    await client.removeNode(uid);
    expect(await hit('desert')).toBe(0);
    close();
  });

  it('upserts (putNode merge over an existing row) do not double-index', async () => {
    const { client, db, close } = await memoryClient();
    const uid = generateId();
    await client.putNode('tour', uid, { name: 'twice written' });
    await client.putNode('tour', uid, { name: 'twice written' });
    const ftsCount = db
      .prepare(`SELECT count(*) AS n FROM "${ftsTableName('firegraph')}"`)
      .get() as { n: number };
    expect(ftsCount.n).toBe(1);
    const results = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'twice',
      limit: 10,
    });
    expect(results).toHaveLength(1);
    close();
  });

  it('backfills records written before the FTS infrastructure existed', async () => {
    const path = tempDbPath('backfill');
    const uid = generateId();

    // Write through the plain shared backend — no FTS DDL installed.
    const rawDb = new Database(path);
    const plain = createSqliteBackend(createBetterSqliteExecutor(rawDb), 'firegraph');
    const plainClient = createGraphClient(plain);
    await plainClient.putNode('tour', uid, { name: 'legacy moonlight row' });
    rawDb.close();

    // Reopen through the local factory — bootstrap must backfill the index.
    const local = await createLocalSqliteBackend(path);
    const client = createGraphClient(local.backend);
    const results = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'moonlight',
      limit: 5,
    });
    expect(results.map((r) => r.aUid)).toEqual([uid]);
    local.close();
  });

  it('indexes writes from a second connection that bypassed the factory', async () => {
    const path = tempDbPath('second-conn');
    const first = await createLocalSqliteBackend(path);
    const client = createGraphClient(first.backend);
    await client.putNode('tour', generateId(), { name: 'starter row' });

    // A second, plain connection (no UDF, no factory) writes through the
    // shared backend — the pure-SQL triggers must keep the index in sync.
    const rawDb = new Database(path);
    const uid = generateId();
    const plainClient = createGraphClient(
      createSqliteBackend(createBetterSqliteExecutor(rawDb), 'firegraph'),
    );
    await plainClient.putNode('tour', uid, { name: 'sidedoor lighthouse' });
    rawDb.close();

    const results = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'lighthouse',
      limit: 5,
    });
    expect(results.map((r) => r.aUid)).toEqual([uid]);
    first.close();
  });

  it('searches subgraphs independently of the parent graph', async () => {
    const { client, close } = await memoryClient();
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'parent meadow' });
    const sub = client.subgraph(parentUid, 'stops');
    const stopUid = generateId();
    await sub.putNode('stop', stopUid, { name: 'hidden waterfall' });

    const subHits = await sub.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'waterfall',
      limit: 5,
    });
    expect(subHits.map((r) => r.aUid)).toEqual([stopUid]);
    // Parent search does not see subgraph rows, and vice versa.
    const parentHits = await client.fullTextSearch({
      query: 'waterfall',
      limit: 5,
      allowCollectionScan: true,
    });
    expect(parentHits).toHaveLength(0);
    const crossHits = await sub.fullTextSearch({
      query: 'meadow',
      limit: 5,
      allowCollectionScan: true,
    });
    expect(crossHits).toHaveLength(0);
    close();
  });

  it('cascade delete sweeps orphaned FTS artifacts and recreated subgraphs have no ghosts', async () => {
    const { client, db, close } = await memoryClient();
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'stops');
    await sub.putNode('stop', generateId(), { name: 'ghostly harbor' });
    const subTable = tableForScope('firegraph', `${parentUid}/stops`);

    const cascade = await client.removeNodeCascade(parentUid);
    expect(cascade.nodeDeleted).toBe(true);

    const remaining = db
      .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(remaining).not.toContain(subTable);
    expect(remaining).not.toContain(ftsTableName(subTable));
    expect(remaining).not.toContain(ftsMapTableName(subTable));

    // Recreate the same subgraph: bootstrap reconciliation must leave no
    // ghost matches from the previous incarnation.
    await client.putNode('tour', parentUid, { name: 'host again' });
    const reborn = client.subgraph(parentUid, 'stops');
    const hits = await reborn.fullTextSearch({
      query: 'harbor',
      limit: 5,
      allowCollectionScan: true,
    });
    expect(hits).toHaveLength(0);
    close();
  });

  it('applies identifying filters', async () => {
    const { client, close } = await memoryClient();
    const tourUid = generateId();
    const stopUid = generateId();
    await client.putNode('tour', tourUid, { name: 'shared keyword zenith' });
    await client.putNode('stop', stopUid, { name: 'shared keyword zenith' });
    const results = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'zenith',
      limit: 10,
    });
    expect(results.map((r) => r.aUid)).toEqual([stopUid]);
    close();
  });

  it('enforces scan-protection without identifying filters', async () => {
    const { client, close } = await memoryClient();
    await expect(client.fullTextSearch({ query: 'anything', limit: 5 })).rejects.toMatchObject({
      code: 'QUERY_SAFETY',
    });
    close();
  });

  it('rejects a non-empty fields list, empty query, and bad limits', async () => {
    const { client, close } = await memoryClient();
    await expect(
      client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'x',
        fields: ['name'],
        limit: 5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', message: expect.stringContaining('fields') });
    await expect(
      client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'x',
        fields: ['aType'],
        limit: 5,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('envelope'),
    });
    await expect(
      client.fullTextSearch({ aType: 'tour', axbType: 'is', query: '', limit: 5 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'x', limit: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'x', limit: 2.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    close();
  });

  it('maps FTS5 syntax errors to INVALID_QUERY', async () => {
    const { client, close } = await memoryClient();
    await client.putNode('tour', generateId(), { name: 'any' });
    await expect(
      client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'AND AND', limit: 5 }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('FTS5'),
    });
    close();
  });

  it('maps FTS5 parse errors the engine raises (not just firegraph validation) to INVALID_QUERY', async () => {
    const { client, close } = await memoryClient();
    await client.putNode('tour', generateId(), { name: 'any' });
    // Each of these is a non-empty string (so it passes firegraph's own
    // validation) that only the FTS5 MATCH parser rejects — previously these
    // escaped as raw SqliteError('SQLITE_ERROR').
    const malformed = [
      '"unclosed phrase (((', // -> "unterminated string"
      '"', // -> "unterminated string"
      'col: bar', // -> "no such column: col"
      '* leading', // -> "unknown special query: leading"
    ];
    for (const query of malformed) {
      await expect(
        client.fullTextSearch({ aType: 'tour', axbType: 'is', query, limit: 5 }),
        query,
      ).rejects.toMatchObject({
        code: 'INVALID_QUERY',
        message: expect.stringContaining('FTS5'),
      });
    }
    close();
  });

  it('supports FTS5 boolean operators and phrase quoting', async () => {
    const { client, close } = await memoryClient();
    const both = generateId();
    const one = generateId();
    await client.putNode('tour', both, { name: 'river rafting adventure' });
    await client.putNode('tour', one, { name: 'river cruise' });
    const andHits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'river AND rafting',
      limit: 10,
    });
    expect(andHits.map((r) => r.aUid)).toEqual([both]);
    const phraseHits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: '"river cruise"',
      limit: 10,
    });
    expect(phraseHits.map((r) => r.aUid)).toEqual([one]);
    close();
  });
});

describe('findNearest', () => {
  async function seededVectors() {
    const ctx = await memoryClient();
    const near = generateId();
    const mid = generateId();
    const far = generateId();
    const noVec = generateId();
    const wrongDim = generateId();
    await ctx.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await ctx.client.putNode('doc', mid, { title: 'mid', embedding: [0.5, 0.5, 0] });
    await ctx.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    await ctx.client.putNode('doc', noVec, { title: 'none' });
    await ctx.client.putNode('doc', wrongDim, { title: 'wrong', embedding: [1, 0] });
    return { ...ctx, near, mid, far, noVec, wrongDim };
  }

  it('orders by EUCLIDEAN distance ascending and skips non-conforming rows', async () => {
    const { client, close, near, mid, far } = await seededVectors();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'EUCLIDEAN',
    });
    // Missing-field and dimension-mismatch rows drop out silently.
    expect(results.map((r) => r.aUid)).toEqual([near, mid, far]);
    close();
  });

  it('orders DOT_PRODUCT descending (higher = more similar)', async () => {
    const { client, close, near, mid } = await seededVectors();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 2,
      distanceMeasure: 'DOT_PRODUCT',
    });
    expect(results.map((r) => r.aUid)).toEqual([near, mid]);
    close();
  });

  it('writes the computed distance into distanceResultField', async () => {
    const { client, close, near } = await seededVectors();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 1,
      distanceMeasure: 'COSINE',
      distanceResultField: 'meta.distance',
    });
    expect(results[0].aUid).toBe(near);
    const meta = (results[0].data as { meta: { distance: number } }).meta;
    expect(meta.distance).toBeCloseTo(0, 10);
    close();
  });

  it('applies distanceThreshold with flipped semantics per measure', async () => {
    const { client, close, near, mid } = await seededVectors();
    // EUCLIDEAN: keep distances <= threshold.
    const close1 = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'EUCLIDEAN',
      distanceThreshold: 0.8,
    });
    expect(close1.map((r) => r.aUid)).toEqual([near, mid]);
    // DOT_PRODUCT: keep similarities >= threshold.
    const close2 = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'DOT_PRODUCT',
      distanceThreshold: 0.4,
    });
    expect(close2.map((r) => r.aUid)).toEqual([near, mid]);
    // COSINE: keep distances (1 − cosine similarity) <= threshold.
    // near → 0, mid → 1 − cos(45°) ≈ 0.293, far → 1.
    const close3 = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'COSINE',
      distanceThreshold: 0.5,
    });
    expect(close3.map((r) => r.aUid)).toEqual([near, mid]);
    close();
  });

  it('self-heals on a recreated subgraph after a parent cascade', async () => {
    const { client, close } = await memoryClient();
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'stops');
    await sub.putNode('stop', generateId(), { name: 'old stop', embedding: [0, 1, 0] });

    const cascade = await client.removeNodeCascade(parentUid);
    expect(cascade.nodeDeleted).toBe(true);

    // The stale subgraph handle's table was dropped by the cascade — the next
    // vector search must re-bootstrap an empty graph instead of throwing.
    const afterDrop = await sub.findNearest({
      aType: 'stop',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0, 1, 0],
      limit: 5,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(afterDrop).toHaveLength(0);

    // And new writes through the healed handle are searchable.
    const rebornUid = generateId();
    await sub.putNode('stop', rebornUid, { name: 'new stop', embedding: [0, 1, 0] });
    const reborn = await sub.findNearest({
      aType: 'stop',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0, 1, 0],
      limit: 5,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(reborn.map((r) => r.aUid)).toEqual([rebornUid]);
    close();
  });

  it('honours where filters and limit', async () => {
    const { client, close, near } = await seededVectors();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'EUCLIDEAN',
      where: [{ field: 'title', op: '==', value: 'near' }],
    });
    expect(results.map((r) => r.aUid)).toEqual([near]);
    const limited = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 1,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(limited).toHaveLength(1);
    close();
  });

  it('accepts a VectorValue-shaped queryVector via toArray()', async () => {
    const { client, close, near } = await seededVectors();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: { toArray: () => [1, 0, 0] },
      limit: 1,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(results[0].aUid).toBe(near);
    close();
  });

  it('searches vectors inside subgraphs', async () => {
    const { client, close } = await memoryClient();
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'docs');
    const uid = generateId();
    await sub.putNode('doc', uid, { embedding: [3, 4] });
    const results = await sub.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0, 0],
      limit: 1,
      distanceMeasure: 'EUCLIDEAN',
      distanceResultField: 'd',
    });
    expect(results[0].aUid).toBe(uid);
    expect((results[0].data as { d: number }).d).toBeCloseTo(5, 10);
    close();
  });

  it('enforces scan-protection and validation errors', async () => {
    const { client, close } = await memoryClient();
    const base = {
      vectorField: 'embedding',
      queryVector: [1, 0],
      limit: 5,
      distanceMeasure: 'EUCLIDEAN' as const,
    };
    await expect(client.findNearest(base)).rejects.toMatchObject({ code: 'QUERY_SAFETY' });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', queryVector: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', limit: 0 }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', limit: 1001 }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    });
    await expect(
      client.findNearest({
        ...base,
        aType: 'doc',
        axbType: 'is',
        distanceMeasure: 'MANHATTAN' as never,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', vectorField: 'aUid' }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('envelope'),
    });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', distanceResultField: 'data' }),
    ).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      message: expect.stringContaining('entire data payload'),
    });
    await expect(
      client.findNearest({ ...base, aType: 'doc', axbType: 'is', queryVector: 'nope' as never }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    close();
  });
});

describe('findNearest — Float64 shadow BLOB column', () => {
  // A registry that DECLARES `data.embedding` as a 3-dim vector. Passing this
  // to the local factory is what materializes the `__vec_embedding` shadow
  // column and switches findNearest onto the blob-scoring branch. Without it,
  // findNearest runs the pure-JSON path (covered by the `findNearest` block).
  const vectorRegistry = () =>
    createRegistry([
      {
        aType: 'doc',
        axbType: 'is',
        bType: 'doc',
        indexes: [{ vector: { field: 'embedding', dimension: 3 }, fields: [] }],
      },
    ]);

  async function memoryVectorClient() {
    const local = await createLocalSqliteBackend(':memory:', { registry: vectorRegistry() });
    return { client: createGraphClient(local.backend), ...local };
  }

  async function seededVectorClient() {
    const ctx = await memoryVectorClient();
    const near = generateId();
    const mid = generateId();
    const far = generateId();
    const noVec = generateId();
    const wrongDim = generateId();
    await ctx.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await ctx.client.putNode('doc', mid, { title: 'mid', embedding: [0.5, 0.5, 0] });
    await ctx.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    await ctx.client.putNode('doc', noVec, { title: 'none' });
    await ctx.client.putNode('doc', wrongDim, { title: 'wrong', embedding: [1, 0] });
    return { ...ctx, near, mid, far, noVec, wrongDim };
  }

  // Open a factory over a caller-managed better-sqlite3 handle (needed for the
  // read-only reopen tests — the factory always opens a writable handle from a
  // path). Passing a Database instance means the factory's `close` is a no-op,
  // so callers close the handle they own.
  async function factoryOver(db: Database.Database, withRegistry: boolean) {
    const local = await createLocalSqliteBackend(
      db,
      withRegistry ? { registry: vectorRegistry() } : {},
    );
    return { local, client: createGraphClient(local.backend) };
  }

  const eucQuery = { vectorField: 'embedding', distanceMeasure: 'EUCLIDEAN' as const };

  it('materializes and populates the __vec_embedding shadow column', async () => {
    const ctx = await seededVectorClient();
    const { client, db, close, near, mid, far, noVec, wrongDim } = ctx;
    // Trigger the lazy ensure + backfill.
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    expect(results.map((r) => r.aUid)).toEqual([near, mid, far]);

    const cols = db.prepare(`PRAGMA table_info('firegraph')`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === '__vec_embedding')).toBe(true);

    const rows = db
      .prepare(
        `SELECT doc_id, __vec_embedding IS NOT NULL AS has_blob, length(__vec_embedding) AS len ` +
          `FROM 'firegraph' WHERE axb_type = 'is'`,
      )
      .all() as Array<{ doc_id: string; has_blob: number; len: number | null }>;
    const byId = new Map(rows.map((r) => [r.doc_id, r]));
    // Conforming 3-dim vectors get a 24-byte (3 × Float64) blob.
    expect(byId.get(near)?.has_blob).toBe(1);
    expect(byId.get(near)?.len).toBe(24);
    expect(byId.get(mid)?.has_blob).toBe(1);
    expect(byId.get(far)?.has_blob).toBe(1);
    // Missing vector and wrong-dimension rows keep a NULL blob → JSON branch.
    expect(byId.get(noVec)?.has_blob).toBe(0);
    expect(byId.get(wrongDim)?.has_blob).toBe(0);
    close();
  });

  it('scores byte-identically to the JSON path for every measure', async () => {
    for (const measure of ['EUCLIDEAN', 'COSINE', 'DOT_PRODUCT'] as const) {
      const { client, close, near, mid, far } = await seededVectorClient();
      const q = [1, 0, 0];
      const results = await client.findNearest({
        aType: 'doc',
        axbType: 'is',
        vectorField: 'embedding',
        queryVector: q,
        limit: 10,
        distanceMeasure: measure,
        distanceResultField: '__d',
      });
      const stored: Record<string, number[]> = {
        [near]: [1, 0, 0],
        [mid]: [0.5, 0.5, 0],
        [far]: [0, 0, 1],
      };
      for (const r of results) {
        const expected = computeVectorDistance(
          JSON.stringify(stored[r.aUid]),
          JSON.stringify(q),
          measure,
        );
        // Exact equality — the blob scorer must reproduce the JSON scorer's
        // doubles bit-for-bit (same decode, same accumulation order).
        expect((r.data as { __d: number }).__d).toBe(expected);
      }
      close();
    }
  });

  it('falls back to the JSON branch for a conforming row whose blob is NULL (back-compat)', async () => {
    const { client, db, close, near } = await seededVectorClient();
    // Materialize + backfill.
    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    // Simulate a row written by a connection that never backfilled: a valid
    // vector but a NULL shadow blob. The cached ensure won't re-backfill, so
    // the CASE must fall to json_extract for this row.
    db.prepare(`UPDATE 'firegraph' SET __vec_embedding = NULL WHERE doc_id = ?`).run(near);
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 1,
      distanceMeasure: 'COSINE',
      distanceResultField: '__d',
    });
    expect(results[0].aUid).toBe(near);
    expect((results[0].data as { __d: number }).__d).toBeCloseTo(0, 12);
    close();
  });

  it('degrades wrong-dimension and missing-vector rows out of the result', async () => {
    const { client, close, near, mid, far, noVec, wrongDim } = await seededVectorClient();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    const uids = results.map((r) => r.aUid);
    expect(uids).toEqual([near, mid, far]);
    expect(uids).not.toContain(noVec);
    expect(uids).not.toContain(wrongDim);
    close();
  });

  it('nulls the shadow blob on a data change and re-scores correctly afterwards', async () => {
    const { client, db, close, near } = await seededVectorClient();
    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    // Change the embedding — the AFTER UPDATE null-on-change trigger fires.
    await client.updateNode(near, { embedding: [0, 1, 0] });
    const after = db
      .prepare(`SELECT __vec_embedding IS NULL AS is_null FROM 'firegraph' WHERE doc_id = ?`)
      .get(near) as { is_null: number };
    expect(after.is_null).toBe(1);
    // A fresh client re-materializes/backfills; the row is scored against the
    // new vector (exact match → distance 0).
    const fresh = createGraphClient(
      (await createLocalSqliteBackend(db, { registry: vectorRegistry() })).backend,
    );
    const results = await fresh.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0, 1, 0],
      limit: 1,
      distanceMeasure: 'EUCLIDEAN',
      distanceResultField: '__d',
    });
    expect(results[0].aUid).toBe(near);
    expect((results[0].data as { __d: number }).__d).toBeCloseTo(0, 12);
    close();
  });

  it('returns correct results via the blob branch on a read-only handle (no throw)', async () => {
    const path = tempDbPath('vec-ro-materialized');
    const writable = new Database(path);
    const seeded = await factoryOver(writable, true);
    const near = generateId();
    const far = generateId();
    await seeded.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await seeded.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    // Force the shadow column + backfill to fully materialize while writable.
    await seeded.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    writable.close();

    const ro = new Database(path, { readonly: true });
    const reopened = await factoryOver(ro, true);
    const results = await reopened.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'COSINE',
    });
    expect(results.map((r) => r.aUid)).toEqual([near, far]);
    ro.close();
  });

  it('returns correct results via the JSON branch on a read-only handle with no shadow column (no throw)', async () => {
    const path = tempDbPath('vec-ro-json');
    // Seed WITHOUT the registry, so the shadow column is never created.
    const writable = new Database(path);
    const seeded = await factoryOver(writable, false);
    const near = generateId();
    const far = generateId();
    await seeded.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await seeded.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    writable.close();

    // Reopen read-only WITH the registry: the lazy ensure would try to ALTER +
    // backfill (writes) and the base bootstrap would try its catalog INSERT —
    // all rejected on a read-only handle. findNearest must swallow those and
    // score through the pure-JSON branch instead of throwing.
    const ro = new Database(path, { readonly: true });
    const reopened = await factoryOver(ro, true);
    const results = await reopened.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'COSINE',
    });
    expect(results.map((r) => r.aUid)).toEqual([near, far]);
    ro.close();
  });

  it('self-heals the shadow column on a recreated subgraph after a parent cascade', async () => {
    const { client, close } = await memoryVectorClient();
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'docs');
    await sub.putNode('doc', generateId(), { title: 'old', embedding: [0, 1, 0] });

    const cascade = await client.removeNodeCascade(parentUid);
    expect(cascade.nodeDeleted).toBe(true);

    // The cascade dropped the subgraph table (and its shadow column). The next
    // vector search must re-bootstrap the table, re-materialize the shadow
    // column/trigger/backfill, and retry — not throw a stale "no such column".
    const afterDrop = await sub.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [0, 1, 0],
      limit: 5,
    });
    expect(afterDrop).toHaveLength(0);

    const rebornUid = generateId();
    await sub.putNode('doc', rebornUid, { title: 'new', embedding: [0, 1, 0] });
    const reborn = await sub.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [0, 1, 0],
      limit: 5,
      distanceResultField: '__d',
    });
    expect(reborn.map((r) => r.aUid)).toEqual([rebornUid]);
    expect((reborn[0].data as { __d: number }).__d).toBeCloseTo(0, 12);
    close();
  });

  it('ranks a larger dataset identically to the reference JSON scorer', async () => {
    const { client, close } = await memoryVectorClient();
    const n = 200;
    const uids: string[] = [];
    const vectors: Record<string, number[]> = {};
    for (let i = 0; i < n; i++) {
      const uid = generateId();
      const vec = [Math.sin(i), Math.cos(i * 0.5), (i % 7) / 7];
      uids.push(uid);
      vectors[uid] = vec;
      await client.putNode('doc', uid, { i, embedding: vec });
    }
    const q = [0.3, -0.4, 0.5];
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: q,
      limit: 10,
      distanceMeasure: 'EUCLIDEAN',
      distanceResultField: '__d',
    });
    // Reference: score every vector with the JSON scorer and take the top 10.
    const reference = uids
      .map((uid) => ({
        uid,
        d: computeVectorDistance(JSON.stringify(vectors[uid]), JSON.stringify(q), 'EUCLIDEAN')!,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 10);
    expect(results.map((r) => r.aUid)).toEqual(reference.map((r) => r.uid));
    // And the distances the blob path emitted match the reference bit-for-bit.
    results.forEach((r, idx) => {
      expect((r.data as { __d: number }).__d).toBe(reference[idx].d);
    });
    close();
  });

  it('generateIndexConfig ignores a vector-only spec (no throw, contributes nothing)', () => {
    // A vector-only spec carries `fields: []`; the Firestore generator emits
    // composite indexes only for specs with ≥2 fields, so the vector entry must
    // add nothing beyond the always-present core defaults.
    const baseline = generateIndexConfig('firegraph', { registryEntries: [] });
    const withVector = generateIndexConfig('firegraph', {
      registryEntries: [
        {
          aType: 'doc',
          axbType: 'is',
          bType: 'doc',
          indexes: [{ vector: { field: 'embedding', dimension: 3 }, fields: [] }],
        },
      ],
    });
    expect(withVector.indexes).toEqual(baseline.indexes);
  });
});

describe('computeVectorDistance', () => {
  const q = JSON.stringify([1, 0]);

  it('computes the three measures', () => {
    expect(computeVectorDistance(JSON.stringify([0, 1]), q, 'EUCLIDEAN')).toBeCloseTo(
      Math.SQRT2,
      12,
    );
    expect(computeVectorDistance(JSON.stringify([0, 1]), q, 'COSINE')).toBeCloseTo(1, 12);
    expect(computeVectorDistance(JSON.stringify([2, 3]), q, 'DOT_PRODUCT')).toBe(2);
    expect(computeVectorDistance(JSON.stringify([1, 0]), q, 'COSINE')).toBeCloseTo(0, 12);
  });

  it('returns null for non-conforming inputs', () => {
    expect(computeVectorDistance(null, q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('not json', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('{"a":1}', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[1,2,3]', q, 'EUCLIDEAN')).toBeNull(); // dimension mismatch
    expect(computeVectorDistance('[1,"x"]', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[1,null]', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[0,0]', q, 'COSINE')).toBeNull(); // zero norm
    expect(computeVectorDistance('[1,0]', q, 'CHEBYSHEV')).toBeNull();
    expect(computeVectorDistance('[1,0]', 'not json', 'EUCLIDEAN')).toBeNull();
  });

  it('memoised query vector does not leak across different queries', () => {
    const q1 = JSON.stringify([1, 0]);
    const q2 = JSON.stringify([0, 1]);
    expect(computeVectorDistance('[1,0]', q1, 'EUCLIDEAN')).toBe(0);
    expect(computeVectorDistance('[1,0]', q2, 'EUCLIDEAN')).toBeCloseTo(Math.SQRT2, 12);
    expect(computeVectorDistance('[1,0]', q1, 'EUCLIDEAN')).toBe(0);
  });
});

describe('isFts5QueryError', () => {
  it('matches the FTS5 MATCH parser complaints (case-insensitively)', () => {
    for (const msg of [
      'unterminated string',
      'fts5: syntax error near "AND"',
      'unknown special query: leading',
      'no such column: col',
      'UNTERMINATED STRING',
    ]) {
      expect(isFts5QueryError(msg), msg).toBe(true);
    }
  });

  it('does NOT match genuine storage / non-query errors', () => {
    for (const msg of [
      'no such table: firegraph_g_abc_sstops',
      'disk I/O error',
      'database disk image is malformed',
      'database is locked',
      'attempt to write a readonly database',
    ]) {
      expect(isFts5QueryError(msg), msg).toBe(false);
    }
  });
});

describe('findOrphanedFtsTables', () => {
  const root = 'firegraph';

  it('flags artifacts whose base subgraph table is gone', () => {
    const dead = `${root}_g_abc_sstops`;
    const orphans = findOrphanedFtsTables(
      [root, `${root}_fts`, `${root}_fts_map`, `${dead}_fts`, `${dead}_fts_map`],
      [],
      root,
    );
    expect(orphans).toEqual([`${dead}_fts`, `${dead}_fts_map`].sort());
  });

  it('keeps artifacts whose base table still exists', () => {
    const live = `${root}_g_abc_sstops`;
    expect(
      findOrphanedFtsTables([root, live, `${live}_fts`, `${live}_fts_map`], [live], root),
    ).toEqual([]);
  });

  it('never flags the root table artifacts or unrelated tables', () => {
    expect(
      findOrphanedFtsTables([`${root}_fts`, `${root}_fts_map`, 'other_fts', 'misc'], [], root),
    ).toEqual([]);
  });

  it('protects a live graph table whose mangled name ends in _fts', () => {
    // A subgraph scope can mangle to a table name that itself ends in
    // '_fts'. Such a table is a live graph, not an artifact.
    const tricky = `${root}_g_abc_smy_fts`;
    // Registered in the catalog and its base ("${root}_g_abc_smy") absent:
    // without the catalog check this would be flagged and DROPped.
    expect(findOrphanedFtsTables([root, tricky], [tricky], root)).toEqual([]);
    // Same name, NOT in the catalog and base missing → it is an orphan
    // artifact of table `${root}_g_abc_smy`.
    expect(findOrphanedFtsTables([root, tricky], [], root)).toEqual([tricky]);
  });

  it('flags per-type FTS partitions whose base subgraph table is gone', () => {
    const dead = `${root}_g_abc_sstops`;
    const orphans = findOrphanedFtsTables(
      [
        root,
        `${root}_fts`,
        `${root}_fts_map`,
        `${dead}_fts`,
        `${dead}_fts_map`,
        `${dead}_fts_t_episode`,
      ],
      [],
      root,
      ['episode'],
    );
    expect(orphans).toEqual([`${dead}_fts`, `${dead}_fts_map`, `${dead}_fts_t_episode`].sort());
  });

  it('does not mistake the _fts_map suffix for a per-type partition named "map"', () => {
    // With 'map' configured as a per-type a_type, the per-type suffix is
    // '_fts_t_map' — distinct from the '_fts_map' rowid table. The live base's
    // rowid map must never be swept, and neither must its live per-type table.
    const live = `${root}_g_abc_sstops`;
    const orphans = findOrphanedFtsTables(
      [root, live, `${live}_fts`, `${live}_fts_map`, `${live}_fts_t_map`],
      [live],
      root,
      ['map'],
    );
    expect(orphans).toEqual([]);
  });
});

describe('per-type BM25 stats (search.fullText)', () => {
  // Read raw bm25 scores straight off an FTS5 table so we can prove the
  // per-type index is genuinely isolated from other-a_type inserts. Returns
  // {rowid, score} pairs (rowid = the shared _fts_map id) ordered by rowid.
  function ftsScores(
    db: Database.Database,
    table: string,
    term: string,
  ): Array<{ rowid: number; score: number }> {
    const rows = db
      .prepare(
        `SELECT rowid AS rowid, bm25("${table}") AS score FROM "${table}" ` +
          `WHERE "${table}" MATCH ? ORDER BY rowid ASC`,
      )
      .all(term) as Array<{ rowid: number; score: number }>;
    return rows.map((r) => ({ rowid: Number(r.rowid), score: Number(r.score) }));
  }

  function tableNames(db: Database.Database): string[] {
    return db
      .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
  }

  // Case 1 — PER-TYPE ON isolates IDF.
  //
  // Note on corpus shape: FTS5's bm25() clamps a term's IDF to 1e-6 whenever
  // the term appears in more than ~half the documents (N - n + 0.5 <= n + 0.5).
  // To exercise a REAL, corpus-size-sensitive IDF (not the clamped floor), the
  // queried term must stay a minority — hence the filler rows that dilute it.
  it('per-type ON: type-B inserts move neither a type-A bm25 score nor its rank', async () => {
    const local = await createLocalSqliteBackend(':memory:', { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(local.backend);
    const a1 = generateId();
    await client.putNode('tour', a1, { text: 'alpha marker' });
    // Filler tour rows that do NOT contain the query term keep 'alpha' rare, so
    // the per-type table's IDF for 'alpha' is a real positive value.
    for (let i = 0; i < 20; i++) {
      await client.putNode('tour', generateId(), { text: 'filler filler' });
    }

    const ptTable = perTypeFtsTableName('firegraph', 'tour');
    const search = () =>
      client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'alpha',
        perTypeStats: true,
        limit: 10,
      });

    const rankBefore = (await search()).map((r) => r.aUid);
    const ptBefore = ftsScores(local.db, ptTable, 'alpha');
    expect(ptBefore).toHaveLength(1); // only a1 (a tour row) contains 'alpha'

    // Flood the SAME graph table with type-B rows that share the query term.
    for (let i = 0; i < 10; i++) {
      await client.putNode('stop', generateId(), { text: 'alpha crowd' });
    }

    const rankAfter = (await search()).map((r) => r.aUid);
    const ptAfter = ftsScores(local.db, ptTable, 'alpha');

    // The per-type table holds only tour rows → bm25 scores AND the returned
    // rank are byte-identical before and after the type-B flood.
    expect(ptAfter).toEqual(ptBefore);
    expect(rankAfter).toEqual(rankBefore);
    local.close();
  });

  // Case 2 — PER-TYPE OFF (default) is unchanged / byte-identical to shared path.
  it('per-type OFF (default): unconfigured backend ignores perTypeStats, builds no per-type table', async () => {
    const local = await createLocalSqliteBackend(':memory:');
    const client = createGraphClient(local.backend);
    const tourUid = generateId();
    const stopUid = generateId();
    await client.putNode('tour', tourUid, { name: 'shared keyword zenith' });
    await client.putNode('stop', stopUid, { name: 'shared keyword zenith' });

    const base = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'zenith',
      limit: 10,
    });
    expect(base.map((r) => r.aUid)).toEqual([stopUid]);

    // Passing perTypeStats on an UNCONFIGURED backend is a silent no-op: same
    // result and order as omitting it (falls back to the shared <t>_fts).
    const optedIn = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'zenith',
      perTypeStats: true,
      limit: 10,
    });
    expect(optedIn.map((r) => r.aUid)).toEqual(base.map((r) => r.aUid));

    // No per-type partition table was created for a default backend.
    expect(tableNames(local.db).some((n) => n.includes('_fts_t_'))).toBe(false);
    local.close();
  });

  // Case 3 — CONTROL: with per-type OFF the shared index score DOES shift.
  // Same corpus shape as case 1 (filler rows keep 'alpha' a minority so bm25's
  // IDF is unclamped), but read against the SHARED index — where the type-B
  // flood DOES move the type-A row's score. Proves the isolation in case 1 is
  // the per-type mechanism, not the corpus.
  it('control: with per-type OFF the shared index score shifts on type-B inserts', async () => {
    const local = await createLocalSqliteBackend(':memory:'); // default, shared index only
    const client = createGraphClient(local.backend);
    const a1 = generateId();
    await client.putNode('tour', a1, { text: 'alpha marker' });
    for (let i = 0; i < 20; i++) {
      await client.putNode('tour', generateId(), { text: 'filler filler' });
    }

    const shared = ftsTableName('firegraph');
    const before = ftsScores(local.db, shared, 'alpha');
    expect(before).toHaveLength(1);

    for (let i = 0; i < 10; i++) {
      await client.putNode('stop', generateId(), { text: 'alpha crowd' });
    }
    const after = ftsScores(local.db, shared, 'alpha');
    const afterByRow = new Map(after.map((s) => [s.rowid, s.score]));

    // a1's own row (its map id is stable) scores differently purely because
    // other-a_type rows entered the shared index. This is the defect the
    // per-type table sidesteps — and proves case 1's stability is real.
    expect(afterByRow.get(before[0].rowid)).not.toBe(before[0].score);
    local.close();
  });

  // Case 4 — FALL-BACK: opt-in read flag with no maintained per-type table.
  it('falls back to the shared index for unconfigured aType / no aType', async () => {
    const local = await createLocalSqliteBackend(':memory:', { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(local.backend);
    const tourUid = generateId();
    const stopUid = generateId();
    await client.putNode('tour', tourUid, { name: 'harbor lighthouse' });
    await client.putNode('stop', stopUid, { name: 'harbor cove' });

    // (a) perTypeStats:true but aType 'stop' is NOT configured → shared index, no error.
    const unconfigured = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'harbor',
      perTypeStats: true,
      limit: 10,
    });
    expect(unconfigured.map((r) => r.aUid)).toEqual([stopUid]);

    // (b) perTypeStats:true with NO aType (cross-type) → shared index, no error.
    const crossType = await client.fullTextSearch({
      query: 'harbor',
      perTypeStats: true,
      allowCollectionScan: true,
      limit: 10,
    });
    expect(new Set(crossType.map((r) => r.aUid))).toEqual(new Set([tourUid, stopUid]));
    local.close();
  });

  // Case 5a — LIFECYCLE: opt in on an already-populated DB (backfill).
  it('backfills per-type tables when opting in on an already-populated DB', async () => {
    const path = tempDbPath('pt-backfill');
    const uid = generateId();

    // Populate through a DEFAULT backend — no per-type table exists yet.
    const first = await createLocalSqliteBackend(path);
    await createGraphClient(first.backend).putNode('tour', uid, { name: 'legacy dawn' });
    first.close();

    // Reopen WITH per-type stats configured → bootstrap builds + backfills it.
    const second = await createLocalSqliteBackend(path, { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(second.backend);
    const hits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'dawn',
      perTypeStats: true,
      limit: 5,
    });
    expect(hits.map((r) => r.aUid)).toEqual([uid]);

    const cnt = second.db
      .prepare(`SELECT count(*) AS n FROM "${perTypeFtsTableName('firegraph', 'tour')}"`)
      .get() as { n: number };
    expect(cnt.n).toBe(1);

    // REGRESSION (reviewer-found): backfill only covers rows that pre-date the
    // opt-in. A row written AFTER bootstrap depends on the FOLDED triggers being
    // current. On a DB whose three FTS triggers already existed from the default
    // (pre-opt-in) run, `CREATE TRIGGER IF NOT EXISTS` would NO-OP and leave the
    // stale (no per-type fold) body installed, so this new row would be missing
    // from the per-type table and a perTypeStats:true search would DROP it.
    const freshUid = generateId();
    await client.putNode('tour', freshUid, { name: 'fresh dusk' });
    const freshHits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'dusk',
      perTypeStats: true,
      limit: 5,
    });
    expect(freshHits.map((r) => r.aUid)).toEqual([freshUid]);
    expect(
      (
        second.db
          .prepare(`SELECT count(*) AS n FROM "${perTypeFtsTableName('firegraph', 'tour')}"`)
          .get() as { n: number }
      ).n,
    ).toBe(2);

    // And DELETE must remove it from the per-type table — no ghost row (the
    // folded AD trigger deletes the per-type row before the map row).
    await client.removeNode(freshUid);
    const afterDelete = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'dusk',
      perTypeStats: true,
      limit: 5,
    });
    expect(afterDelete).toHaveLength(0);
    expect(
      (
        second.db
          .prepare(`SELECT count(*) AS n FROM "${perTypeFtsTableName('firegraph', 'tour')}"`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
    second.close();
  });

  // Case 5b — LIFECYCLE: writes from a second plain connection stay in sync.
  it('keeps per-type tables in sync for writes from a second plain connection', async () => {
    const path = tempDbPath('pt-second-conn');
    const first = await createLocalSqliteBackend(path, { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(first.backend);
    await client.putNode('tour', generateId(), { name: 'starter beacon' });

    // A second, plain connection (shared backend, no FTS DDL of its own) writes
    // through the table — the folded per-type triggers (static SQL that lives
    // in the schema) must maintain the per-type table regardless of connection.
    const rawDb = new Database(path);
    const uid = generateId();
    await createGraphClient(
      createSqliteBackend(createBetterSqliteExecutor(rawDb), 'firegraph'),
    ).putNode('tour', uid, { name: 'sidedoor sentinel' });
    rawDb.close();

    const hits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'sentinel',
      perTypeStats: true,
      limit: 5,
    });
    expect(hits.map((r) => r.aUid)).toEqual([uid]);
    first.close();
  });

  // Case 5c — LIFECYCLE: per-type search inside a lazily created subgraph.
  it('supports per-type search inside a subgraph and builds its partition table', async () => {
    const { backend, db, close } = await createLocalSqliteBackend(':memory:', {
      perTypeFtsStats: ['stop'],
    });
    const client = createGraphClient(backend);
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'parent basin' });
    const sub = client.subgraph(parentUid, 'stops');
    const s1 = generateId();
    await sub.putNode('stop', s1, { text: 'harbor harbor cliff' });
    for (let i = 0; i < 40; i++) {
      await sub.putNode('note', generateId(), { text: 'harbor harbor harbor' });
    }

    const hits = await sub.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'harbor',
      perTypeStats: true,
      limit: 5,
    });
    expect(hits.map((r) => r.aUid)).toEqual([s1]);

    const subTable = tableForScope('firegraph', `${parentUid}/stops`);
    expect(tableNames(db)).toContain(perTypeFtsTableName(subTable, 'stop'));
    close();
  });

  // Case 5d — LIFECYCLE: cascade delete sweeps per-type partitions.
  it('cascade delete sweeps per-type FTS partitions of dropped subgraphs', async () => {
    const { backend, db, close } = await createLocalSqliteBackend(':memory:', {
      perTypeFtsStats: ['stop'],
    });
    const client = createGraphClient(backend);
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'stops');
    await sub.putNode('stop', generateId(), { text: 'ghostly reef' });

    const subTable = tableForScope('firegraph', `${parentUid}/stops`);
    const ptTable = perTypeFtsTableName(subTable, 'stop');
    expect(tableNames(db)).toContain(ptTable);

    const cascade = await client.removeNodeCascade(parentUid);
    expect(cascade.nodeDeleted).toBe(true);

    const remaining = tableNames(db);
    expect(remaining).not.toContain(ptTable);
    expect(remaining).not.toContain(subTable);
    expect(remaining).not.toContain(ftsTableName(subTable));
    close();
  });
});

describe('per-type FTS: declared fields (IndexSpec.fullText) + auto-routing', () => {
  function tableNames(db: Database.Database): string[] {
    return db
      .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
  }

  // A registry declaring per-type searchable FIELDS (not whole text) builds a
  // field-scoped partition. Combined with auto-routing this is directly
  // observable: a single-aType search DEFAULT-routes to the partition, so a
  // term that lives only in a NON-declared field is unfindable there — while
  // forcing the shared index (`perTypeStats: false`) finds it.
  it('indexes only declared fields and auto-routes single-aType search to the partition', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['title'] } }],
      },
    ]);
    const local = await createLocalSqliteBackend(':memory:', { registry });
    const client = createGraphClient(local.backend);
    const uid = generateId();
    await client.putNode('tour', uid, { title: 'alphaword', body: 'betaword' });

    // Partition exists and holds the declared-field text.
    expect(tableNames(local.db)).toContain(perTypeFtsTableName('firegraph', 'tour'));

    // A term in the DECLARED field is found via the auto-routed partition
    // (no `perTypeStats` flag passed — routing is default-on when configured).
    const titleHit = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'alphaword',
      limit: 5,
    });
    expect(titleHit.map((r) => r.aUid)).toEqual([uid]);

    // A term in the NON-declared field is NOT in the partition, so the
    // auto-routed search misses it.
    const bodyMiss = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'betaword',
      limit: 5,
    });
    expect(bodyMiss).toHaveLength(0);

    // Forcing the shared cross-type index (`perTypeStats: false`) indexes ALL
    // text, so the same body term IS found — proving the miss above was the
    // partition's field scope, not a lost row.
    const bodyViaShared = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'betaword',
      perTypeStats: false,
      limit: 5,
    });
    expect(bodyViaShared.map((r) => r.aUid)).toEqual([uid]);
    local.close();
  });

  // Two entries sharing an a_type UNION + de-dupe their declared field paths
  // into one partition field set.
  it('unions declared field paths across entries sharing an a_type', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['title'] } }],
      },
      {
        aType: 'tour',
        axbType: 'hasNote',
        bType: 'note',
        indexes: [{ fields: [], fullText: { fields: ['summary'] } }],
      },
    ]);
    const local = await createLocalSqliteBackend(':memory:', { registry });
    const client = createGraphClient(local.backend);
    const uid = generateId();
    await client.putNode('tour', uid, { title: 'peakword', summary: 'valleyword' });

    for (const term of ['peakword', 'valleyword']) {
      const hits = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: term,
        limit: 5,
      });
      expect(hits.map((r) => r.aUid)).toEqual([uid]);
    }
    local.close();
  });

  // A field-list CHANGE on reopen must fully rebuild the partition for rows
  // that were already indexed under the OLD extraction — the idempotent
  // bootstrap backfill only inserts MISSING rows, so this is the case the
  // `<root>_fts_cfg` fingerprint reconciliation exists to cover.
  it('re-fingerprints and rebuilds the partition when the declared field list changes', async () => {
    const path = tempDbPath('pt-fingerprint');
    const uid = generateId();

    const narrow = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['title'] } }],
      },
    ]);
    const first = await createLocalSqliteBackend(path, { registry: narrow });
    await createGraphClient(first.backend).putNode('tour', uid, {
      title: 'aurora',
      body: 'borealis',
    });
    // Under the narrow ('title' only) config, the body term is not in the partition.
    const miss = await createGraphClient(first.backend).fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'borealis',
      limit: 5,
    });
    expect(miss).toHaveLength(0);
    first.close();

    // Reopen with 'body' ADDED → fingerprint change → purge + rebuild partition
    // with both fields, re-extracting the pre-existing row.
    const wide = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['title', 'body'] } }],
      },
    ]);
    const second = await createLocalSqliteBackend(path, { registry: wide });
    const client = createGraphClient(second.backend);
    const hit = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'borealis',
      limit: 5,
    });
    expect(hit.map((r) => r.aUid)).toEqual([uid]);

    // Fingerprint row now reflects the widened field list.
    const fp = second.db
      .prepare(
        `SELECT "fingerprint" FROM "${ftsCfgTableName('firegraph')}" ` +
          `WHERE "table_name" = 'firegraph' AND "a_type" = 'tour'`,
      )
      .get() as { fingerprint: string };
    expect(JSON.parse(fp.fingerprint)).toEqual({ fields: ['body', 'title'] });
    second.close();
  });

  it('rejects the same a_type declared via both perTypeFtsStats and IndexSpec.fullText', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['title'] } }],
      },
    ]);
    await expect(
      createLocalSqliteBackend(':memory:', { registry, perTypeFtsStats: ['tour'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects an IndexSpec.fullText with an unsafe field path', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: ['bad!key'] } }],
      },
    ]);
    await expect(createLocalSqliteBackend(':memory:', { registry })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects an IndexSpec.fullText with an empty field list', async () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        indexes: [{ fields: [], fullText: { fields: [] } }],
      },
    ]);
    await expect(createLocalSqliteBackend(':memory:', { registry })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  // The empty-config path must stay byte-identical to the pre-per-type shape:
  // no partition DDL, no `_fts_t_`, all shared triggers `IF NOT EXISTS`, and no
  // `<root>_fts_cfg` table ever created.
  it('empty config emits only shared FTS DDL (byte-identical, no partitions)', () => {
    const table = 'firegraph';
    const ddl = buildLocalSearchDDL(table, new Map());
    expect(ddl).toEqual([...buildFtsDDL(table), ...buildFtsSyncStatements(table)]);
    expect(ddl.some((s) => s.includes('_fts_t_'))).toBe(false);
    expect(
      buildFtsDDL(table)
        .filter((s) => s.includes('TRIGGER'))
        .every((s) => s.includes('CREATE TRIGGER IF NOT EXISTS')),
    ).toBe(true);
  });

  it('does not create a _fts_cfg table for a default (empty-config) backend', async () => {
    const local = await createLocalSqliteBackend(':memory:');
    const client = createGraphClient(local.backend);
    await client.putNode('tour', generateId(), { name: 'plain' });
    await client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'plain', limit: 5 });
    expect(tableNames(local.db)).not.toContain(ftsCfgTableName('firegraph'));
    local.close();
  });

  // A 0.19.0 database installed the per-type maintenance FOLDED into the shared
  // triggers (body references `<t>_fts_t_…`). The JS `doFtsEnsure` phase-1 heal
  // replaces any such folded shared trigger with the clean shared-only body,
  // regardless of the current config.
  it('heals a legacy folded shared FTS trigger on reopen', async () => {
    const path = tempDbPath('legacy-heal');
    const first = await createLocalSqliteBackend(path);
    await createGraphClient(first.backend).putNode('tour', generateId(), { name: 'relic' });
    first.close();

    // Simulate the folded trigger: replace the clean AFTER INSERT trigger with
    // one whose body text references a per-type partition (`_fts_t_`).
    const raw = new Database(path);
    raw.exec(`DROP TRIGGER IF EXISTS "firegraph_fts_ai"`);
    raw.exec(
      `CREATE TRIGGER "firegraph_fts_ai" AFTER INSERT ON "firegraph" ` +
        `BEGIN SELECT '_fts_t_tour'; END`,
    );
    const broken = raw
      .prepare(`SELECT "sql" FROM sqlite_master WHERE "name" = 'firegraph_fts_ai'`)
      .get() as { sql: string };
    expect(broken.sql).toContain('_fts_t_');
    raw.close();

    // Reopen and run a search → phase-1 heal fires.
    const second = await createLocalSqliteBackend(path);
    const client = createGraphClient(second.backend);
    await client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'relic', limit: 5 });

    const healed = second.db
      .prepare(`SELECT "sql" FROM sqlite_master WHERE "name" = 'firegraph_fts_ai'`)
      .get() as { sql: string };
    expect(healed.sql).not.toContain('_fts_t_');
    // The healed trigger body is exactly the canonical shared AFTER INSERT def.
    // (SQLite drops the `IF NOT EXISTS` clause when persisting to sqlite_master,
    // so normalise it out of the canonical statement before comparing.)
    const canonicalAi = sharedFtsTriggerDefs('firegraph').find(
      (d) => d.name === 'firegraph_fts_ai',
    );
    expect(healed.sql).toBe(
      canonicalAi?.statement.replace('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER'),
    );

    // A fresh insert is indexed by the healed shared trigger.
    const freshUid = generateId();
    await client.putNode('tour', freshUid, { name: 'renewed' });
    const hits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'renewed',
      limit: 5,
    });
    expect(hits.map((r) => r.aUid)).toEqual([freshUid]);
    second.close();
  });

  // The cascade sweep purges `<root>_fts_cfg` fingerprint rows of a dropped
  // subgraph so a future recreate re-fingerprints from scratch.
  it('sweeps _fts_cfg rows for a cascade-dropped subgraph', async () => {
    const registry = createRegistry([
      {
        aType: 'stop',
        axbType: 'is',
        bType: 'stop',
        indexes: [{ fields: [], fullText: { fields: ['text'] } }],
      },
    ]);
    const { backend, db, close } = await createLocalSqliteBackend(':memory:', { registry });
    const client = createGraphClient(backend);
    const parentUid = generateId();
    await client.putNode('tour', parentUid, { name: 'host' });
    const sub = client.subgraph(parentUid, 'stops');
    await sub.putNode('stop', generateId(), { text: 'reef' });
    // Force the subgraph's doFtsEnsure to write its fingerprint row.
    await sub.fullTextSearch({ aType: 'stop', axbType: 'is', query: 'reef', limit: 5 });

    const subTable = tableForScope('firegraph', `${parentUid}/stops`);
    const cfg = ftsCfgTableName('firegraph');
    const before = db
      .prepare(`SELECT "table_name" FROM "${cfg}" WHERE "table_name" = ?`)
      .all(subTable);
    expect(before.length).toBeGreaterThan(0);

    await client.removeNodeCascade(parentUid);

    const after = db
      .prepare(`SELECT "table_name" FROM "${cfg}" WHERE "table_name" = ?`)
      .all(subTable);
    expect(after).toHaveLength(0);
    close();
  });
});
