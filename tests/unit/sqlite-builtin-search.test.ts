/**
 * Tests for `firegraph/sqlite-builtin` search capabilities:
 * `search.fullText` (FTS5 index synced by pure-SQL triggers) and
 * `search.vector` (brute-force scan scored by a connection-local UDF).
 *
 * Mirrors `sqlite-local-search.test.ts` exactly, adapted for the DatabaseSync
 * driver. All describe blocks that touch a database are skip-guarded on
 * Node < 22.5 where node:sqlite is absent. Pure-function describes
 * (`computeVectorDistance`, `isFts5QueryError`, `findOrphanedFtsTables`)
 * do NOT need the skip guard — they have no Node version dependency.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGraphClient } from '../../src/client.js';
import { generateId } from '../../src/id.js';
import {
  computeVectorDistance,
  findOrphanedFtsTables,
  ftsMapTableName,
  ftsTableName,
  isFts5QueryError,
} from '../../src/internal/sqlite-search.js';
import { createSqliteBackend } from '../../src/sqlite/backend.js';
import { tableForScope } from '../../src/sqlite/catalog.js';
import { createNodeSqliteBackend, createNodeSqliteExecutor } from '../../src/sqlite/node-sqlite.js';

// node:sqlite requires Node >= 22.5. Check by version.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const HAS_NODE_SQLITE = nodeMajor > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 5);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'firegraph-sqlite-builtin-search-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  return join(dir, `${name}.db`);
}

async function memoryClient() {
  const local = await createNodeSqliteBackend(':memory:');
  return { client: createGraphClient(local.backend), ...local };
}

describe.skipIf(!HAS_NODE_SQLITE)('capability surface', () => {
  it('declares search.fullText and search.vector on top of the shared set', async () => {
    const { backend, close } = await createNodeSqliteBackend(':memory:');
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
    expect('findEdgesGlobal' in backend).toBe(false);
    close();
  });

  it('subgraph backends carry the search capabilities', async () => {
    const { backend, close } = await createNodeSqliteBackend(':memory:');
    const child = backend.subgraph(generateId(), 'inventory');
    const caps = new Set(child.capabilities.values());
    expect(caps.has('search.fullText' as never)).toBe(true);
    expect(caps.has('search.vector' as never)).toBe(true);
    close();
  });
});

describe.skipIf(!HAS_NODE_SQLITE)('fullTextSearch', () => {
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

    await client.updateNode(uid, { name: 'volcano walk' });
    expect(await hit('glacier')).toBe(0);
    expect(await hit('volcano')).toBe(1);

    await client.replaceNode('tour', uid, { name: 'desert ride' });
    expect(await hit('volcano')).toBe(0);
    expect(await hit('desert')).toBe(1);

    const batchUid = generateId();
    const batch = client.batch();
    batch.putNode('tour', batchUid, { name: 'batched canyon' });
    await batch.commit();
    expect(await hit('canyon')).toBe(1);

    const txUid = generateId();
    await client.runTransaction(async (tx) => {
      await tx.putNode('tour', txUid, { name: 'transactional fjord' });
    });
    expect(await hit('fjord')).toBe(1);

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
    const { DatabaseSync } = await import('node:sqlite');
    const path = tempDbPath('backfill');
    const uid = generateId();

    // Write through the plain shared backend — no FTS DDL installed.
    const rawDb = new DatabaseSync(path);
    const plain = createSqliteBackend(createNodeSqliteExecutor(rawDb), 'firegraph');
    const plainClient = createGraphClient(plain);
    await plainClient.putNode('tour', uid, { name: 'legacy moonlight row' });
    rawDb.close();

    // Reopen through the builtin factory — bootstrap must backfill the index.
    const local = await createNodeSqliteBackend(path);
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
    const { DatabaseSync } = await import('node:sqlite');
    const path = tempDbPath('second-conn');
    const first = await createNodeSqliteBackend(path);
    const client = createGraphClient(first.backend);
    await client.putNode('tour', generateId(), { name: 'starter row' });

    // A second, plain connection (no UDF, no factory) writes through the
    // shared backend — the pure-SQL triggers must keep the index in sync.
    const rawDb = new DatabaseSync(path);
    const uid = generateId();
    const plainClient = createGraphClient(
      createSqliteBackend(createNodeSqliteExecutor(rawDb), 'firegraph'),
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

    const remaining = (
      db.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(remaining).not.toContain(subTable);
    expect(remaining).not.toContain(ftsTableName(subTable));
    expect(remaining).not.toContain(ftsMapTableName(subTable));

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

describe.skipIf(!HAS_NODE_SQLITE)('findNearest', () => {
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

    const afterDrop = await sub.findNearest({
      aType: 'stop',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [0, 1, 0],
      limit: 5,
      distanceMeasure: 'EUCLIDEAN',
    });
    expect(afterDrop).toHaveLength(0);

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

// Pure-function describes — no Node version dependency, no skip guard.

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
    expect(computeVectorDistance('[1,2,3]', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[1,"x"]', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[1,null]', q, 'EUCLIDEAN')).toBeNull();
    expect(computeVectorDistance('[0,0]', q, 'COSINE')).toBeNull();
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
    const tricky = `${root}_g_abc_smy_fts`;
    expect(findOrphanedFtsTables([root, tricky], [tricky], root)).toEqual([]);
    expect(findOrphanedFtsTables([root, tricky], [], root)).toEqual([tricky]);
  });
});
