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

// node:sqlite requires Node >= 22.5. Check by version.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const HAS_NODE_SQLITE = nodeMajor > 22 || (nodeMajor === 22 && (nodeMinor ?? 0) >= 5);

// These are populated dynamically inside HAS_NODE_SQLITE-guarded beforeAll blocks.
// They must NOT be imported statically — node:sqlite throws at load time on Node < 22.5.

let createNodeSqliteBackend: (...args: any[]) => Promise<any>;

let createNodeSqliteExecutor: (...args: any[]) => any;

// Minimal structural type for node:sqlite's `DatabaseSync`. Avoids an inline
// `import()` type annotation (banned by consistent-type-imports) and a static
// `node:sqlite` import (throws at module load on Node < 22.5) — model only the
// surface the vector tests touch.
interface NodeDatabaseSyncHandle {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  };
}
type NodeDatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean },
) => NodeDatabaseSyncHandle;

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
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

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
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

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
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

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

describe.skipIf(!HAS_NODE_SQLITE)('findNearest — Float64 shadow BLOB column', () => {
  let DatabaseSync: NodeDatabaseSyncCtor;
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
    ({ DatabaseSync } = await import('node:sqlite'));
  });

  // A registry that DECLARES `data.embedding` as a 3-dim vector — what
  // materializes the `__vec_embedding` shadow column and switches findNearest
  // onto the blob-scoring branch.
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
    const local = await createNodeSqliteBackend(':memory:', { registry: vectorRegistry() });
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

  // Open a factory over a caller-managed DatabaseSync handle (needed for the
  // read-only reopen tests — the factory always opens a writable handle from a
  // path). Passing a handle means the factory's `close` is a no-op, so callers
  // close the handle they own.
  async function factoryOver(db: NodeDatabaseSyncHandle, withRegistry: boolean) {
    const local = await createNodeSqliteBackend(
      db,
      withRegistry ? { registry: vectorRegistry() } : {},
    );
    return { local, client: createGraphClient(local.backend) };
  }

  const eucQuery = { vectorField: 'embedding', distanceMeasure: 'EUCLIDEAN' as const };

  it('materializes and populates the __vec_embedding shadow column', async () => {
    const { client, db, close, near, mid, far, noVec, wrongDim } = await seededVectorClient();
    const results = await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    expect(results.map((r: { aUid: string }) => r.aUid)).toEqual([near, mid, far]);

    const cols = db.prepare(`PRAGMA table_info('firegraph')`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === '__vec_embedding')).toBe(true);

    const rows = db
      .prepare(
        `SELECT doc_id, __vec_embedding IS NOT NULL AS has_blob, length(__vec_embedding) AS len ` +
          `FROM 'firegraph' WHERE axb_type = 'is'`,
      )
      .all() as Array<{ doc_id: string; has_blob: number; len: number | null }>;
    const byId = new Map(rows.map((r) => [r.doc_id, r]));
    expect(byId.get(near)?.has_blob).toBe(1);
    expect(byId.get(near)?.len).toBe(24);
    expect(byId.get(mid)?.has_blob).toBe(1);
    expect(byId.get(far)?.has_blob).toBe(1);
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
        expect((r.data as { __d: number }).__d).toBe(expected);
      }
      close();
    }
  });

  it('falls back to the JSON branch for a conforming row whose blob is NULL (back-compat)', async () => {
    const { client, db, close, near } = await seededVectorClient();
    await client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
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
    const uids = results.map((r: { aUid: string }) => r.aUid);
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
    await client.updateNode(near, { embedding: [0, 1, 0] });
    const after = db
      .prepare(`SELECT __vec_embedding IS NULL AS is_null FROM 'firegraph' WHERE doc_id = ?`)
      .get(near) as { is_null: number };
    expect(after.is_null).toBe(1);
    const fresh = createGraphClient(
      (await createNodeSqliteBackend(db, { registry: vectorRegistry() })).backend,
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
    const writable = new DatabaseSync(path);
    const seeded = await factoryOver(writable, true);
    const near = generateId();
    const far = generateId();
    await seeded.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await seeded.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    await seeded.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      ...eucQuery,
      queryVector: [1, 0, 0],
      limit: 10,
    });
    writable.close();

    const ro = new DatabaseSync(path, { readOnly: true });
    const reopened = await factoryOver(ro, true);
    const results = await reopened.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'COSINE',
    });
    expect(results.map((r: { aUid: string }) => r.aUid)).toEqual([near, far]);
    ro.close();
  });

  it('returns correct results via the JSON branch on a read-only handle with no shadow column (no throw)', async () => {
    const path = tempDbPath('vec-ro-json');
    const writable = new DatabaseSync(path);
    const seeded = await factoryOver(writable, false);
    const near = generateId();
    const far = generateId();
    await seeded.client.putNode('doc', near, { title: 'near', embedding: [1, 0, 0] });
    await seeded.client.putNode('doc', far, { title: 'far', embedding: [0, 0, 1] });
    writable.close();

    const ro = new DatabaseSync(path, { readOnly: true });
    const reopened = await factoryOver(ro, true);
    const results = await reopened.client.findNearest({
      aType: 'doc',
      axbType: 'is',
      vectorField: 'embedding',
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: 'COSINE',
    });
    expect(results.map((r: { aUid: string }) => r.aUid)).toEqual([near, far]);
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
    expect(reborn.map((r: { aUid: string }) => r.aUid)).toEqual([rebornUid]);
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
    const reference = uids
      .map((uid) => ({
        uid,
        d: computeVectorDistance(JSON.stringify(vectors[uid]), JSON.stringify(q), 'EUCLIDEAN')!,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 10);
    expect(results.map((r: { aUid: string }) => r.aUid)).toEqual(reference.map((r) => r.uid));
    results.forEach((r: { data: unknown }, idx: number) => {
      expect((r.data as { __d: number }).__d).toBe(reference[idx].d);
    });
    close();
  });

  it('generateIndexConfig ignores a vector-only spec (no throw, contributes nothing)', () => {
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

describe.skipIf(!HAS_NODE_SQLITE)('per-type BM25 stats (search.fullText)', () => {
  beforeAll(async () => {
    ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
      await import('../../src/sqlite/node-sqlite.js'));
  });

  // Read raw bm25 scores straight off an FTS5 table so we can prove the
  // per-type index is genuinely isolated from other-a_type inserts. Returns
  // {rowid, score} pairs (rowid = the shared _fts_map id) ordered by rowid.
  function ftsScores(
    db: NodeDatabaseSyncHandle,
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

  function tableNames(db: NodeDatabaseSyncHandle): string[] {
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
    const local = await createNodeSqliteBackend(':memory:', { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(local.backend);
    const a1 = generateId();
    await client.putNode('tour', a1, { text: 'alpha marker' });
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

    const rankBefore = (await search()).map((r: { aUid: string }) => r.aUid);
    const ptBefore = ftsScores(local.db, ptTable, 'alpha');
    expect(ptBefore).toHaveLength(1); // only a1 (a tour row) contains 'alpha'

    for (let i = 0; i < 10; i++) {
      await client.putNode('stop', generateId(), { text: 'alpha crowd' });
    }

    const rankAfter = (await search()).map((r: { aUid: string }) => r.aUid);
    const ptAfter = ftsScores(local.db, ptTable, 'alpha');

    expect(ptAfter).toEqual(ptBefore);
    expect(rankAfter).toEqual(rankBefore);
    local.close();
  });

  // Case 2 — PER-TYPE OFF (default) is unchanged / byte-identical to shared path.
  it('per-type OFF (default): unconfigured backend ignores perTypeStats, builds no per-type table', async () => {
    const local = await createNodeSqliteBackend(':memory:');
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
    expect(base.map((r: { aUid: string }) => r.aUid)).toEqual([stopUid]);

    const optedIn = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'zenith',
      perTypeStats: true,
      limit: 10,
    });
    expect(optedIn.map((r: { aUid: string }) => r.aUid)).toEqual(
      base.map((r: { aUid: string }) => r.aUid),
    );

    expect(tableNames(local.db).some((n) => n.includes('_fts_t_'))).toBe(false);
    local.close();
  });

  // Case 3 — CONTROL: with per-type OFF the shared index score DOES shift.
  // Same corpus shape as case 1 (filler rows keep 'alpha' a minority so bm25's
  // IDF is unclamped), but read against the SHARED index — where the type-B
  // flood DOES move the type-A row's score. Proves the isolation in case 1 is
  // the per-type mechanism, not the corpus.
  it('control: with per-type OFF the shared index score shifts on type-B inserts', async () => {
    const local = await createNodeSqliteBackend(':memory:');
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

    expect(afterByRow.get(before[0].rowid)).not.toBe(before[0].score);
    local.close();
  });

  // Case 4 — FALL-BACK: opt-in read flag with no maintained per-type table.
  it('falls back to the shared index for unconfigured aType / no aType', async () => {
    const local = await createNodeSqliteBackend(':memory:', { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(local.backend);
    const tourUid = generateId();
    const stopUid = generateId();
    await client.putNode('tour', tourUid, { name: 'harbor lighthouse' });
    await client.putNode('stop', stopUid, { name: 'harbor cove' });

    const unconfigured = await client.fullTextSearch({
      aType: 'stop',
      axbType: 'is',
      query: 'harbor',
      perTypeStats: true,
      limit: 10,
    });
    expect(unconfigured.map((r: { aUid: string }) => r.aUid)).toEqual([stopUid]);

    const crossType = await client.fullTextSearch({
      query: 'harbor',
      perTypeStats: true,
      allowCollectionScan: true,
      limit: 10,
    });
    expect(new Set(crossType.map((r: { aUid: string }) => r.aUid))).toEqual(
      new Set([tourUid, stopUid]),
    );
    local.close();
  });

  // Case 5a — LIFECYCLE: opt in on an already-populated DB (backfill).
  it('backfills per-type tables when opting in on an already-populated DB', async () => {
    const path = tempDbPath('pt-backfill');
    const uid = generateId();

    const first = await createNodeSqliteBackend(path);
    await createGraphClient(first.backend).putNode('tour', uid, { name: 'legacy dawn' });
    first.close();

    const second = await createNodeSqliteBackend(path, { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(second.backend);
    const hits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'dawn',
      perTypeStats: true,
      limit: 5,
    });
    expect(hits.map((r: { aUid: string }) => r.aUid)).toEqual([uid]);

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
    expect(freshHits.map((r: { aUid: string }) => r.aUid)).toEqual([freshUid]);
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
    const { DatabaseSync } = await import('node:sqlite');
    const path = tempDbPath('pt-second-conn');
    const first = await createNodeSqliteBackend(path, { perTypeFtsStats: ['tour'] });
    const client = createGraphClient(first.backend);
    await client.putNode('tour', generateId(), { name: 'starter beacon' });

    const rawDb = new DatabaseSync(path);
    const uid = generateId();
    await createGraphClient(
      createSqliteBackend(createNodeSqliteExecutor(rawDb), 'firegraph'),
    ).putNode('tour', uid, { name: 'sidedoor sentinel' });
    rawDb.close();

    const hits = await client.fullTextSearch({
      aType: 'tour',
      axbType: 'is',
      query: 'sentinel',
      perTypeStats: true,
      limit: 5,
    });
    expect(hits.map((r: { aUid: string }) => r.aUid)).toEqual([uid]);
    first.close();
  });

  // Case 5c — LIFECYCLE: per-type search inside a lazily created subgraph.
  it('supports per-type search inside a subgraph and builds its partition table', async () => {
    const { backend, db, close } = await createNodeSqliteBackend(':memory:', {
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
    expect(hits.map((r: { aUid: string }) => r.aUid)).toEqual([s1]);

    const subTable = tableForScope('firegraph', `${parentUid}/stops`);
    expect(tableNames(db)).toContain(perTypeFtsTableName(subTable, 'stop'));
    close();
  });

  // Case 5d — LIFECYCLE: cascade delete sweeps per-type partitions.
  it('cascade delete sweeps per-type FTS partitions of dropped subgraphs', async () => {
    const { backend, db, close } = await createNodeSqliteBackend(':memory:', {
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

  // Case 6 — a_type CHANGE on UPDATE moves the row between partitions (the
  // per-type `_au` path) and out of every partition on a change to an
  // undeclared type; DELETE (the `_bd` path) leaves no ghost. Mirror of the
  // sqlite-local-search test.
  it('a_type change on UPDATE moves the row between per-type partitions', async () => {
    const local = await createNodeSqliteBackend(':memory:', {
      perTypeFtsStats: ['tour', 'stop'],
    });
    const client = createGraphClient(local.backend);
    const uid = generateId();
    const tourPt = perTypeFtsTableName('firegraph', 'tour');
    const stopPt = perTypeFtsTableName('firegraph', 'stop');
    const ptCount = (table: string): number =>
      (local.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const ptSearch = (aType: string) =>
      client.fullTextSearch({
        aType,
        axbType: 'is',
        query: 'chameleon',
        perTypeStats: true,
        limit: 5,
      });

    await client.putNode('tour', uid, { text: 'chameleon marker' });
    expect((await ptSearch('tour')).map((r: { aUid: string }) => r.aUid)).toEqual([uid]);
    expect(ptCount(tourPt)).toBe(1);
    expect(ptCount(stopPt)).toBe(0);

    await client.putNode('stop', uid, { text: 'chameleon marker' });
    expect(ptCount(tourPt)).toBe(0);
    expect(ptCount(stopPt)).toBe(1);
    expect((await ptSearch('stop')).map((r: { aUid: string }) => r.aUid)).toEqual([uid]);
    expect(await ptSearch('tour')).toHaveLength(0);

    await client.putNode('note', uid, { text: 'chameleon marker' });
    expect(ptCount(tourPt)).toBe(0);
    expect(ptCount(stopPt)).toBe(0);

    await client.putNode('stop', uid, { text: 'chameleon marker' });
    expect(ptCount(stopPt)).toBe(1);
    await client.removeNode(uid);
    expect(ptCount(stopPt)).toBe(0);
    expect(await ptSearch('stop')).toHaveLength(0);
    local.close();
  });
});

describe.skipIf(!HAS_NODE_SQLITE)(
  'per-type FTS: declared fields (IndexSpec.fullText) + auto-routing',
  () => {
    let DatabaseSync: NodeDatabaseSyncCtor;
    beforeAll(async () => {
      ({ createNodeSqliteBackend, createNodeSqliteExecutor } =
        await import('../../src/sqlite/node-sqlite.js'));
      ({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
        DatabaseSync: NodeDatabaseSyncCtor;
      });
    });

    function tableNames(db: NodeDatabaseSyncHandle): string[] {
      return db
        .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table'`)
        .all()
        .map((r) => (r as { name: string }).name);
    }

    it('indexes only declared fields and auto-routes single-aType search to the partition', async () => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          indexes: [{ fields: [], fullText: { fields: ['title'] } }],
        },
      ]);
      const local = await createNodeSqliteBackend(':memory:', { registry });
      const client = createGraphClient(local.backend);
      const uid = generateId();
      await client.putNode('tour', uid, { title: 'alphaword', body: 'betaword' });

      expect(tableNames(local.db)).toContain(perTypeFtsTableName('firegraph', 'tour'));

      const titleHit = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'alphaword',
        limit: 5,
      });
      expect(titleHit.map((r) => r.aUid)).toEqual([uid]);

      const bodyMiss = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'betaword',
        limit: 5,
      });
      expect(bodyMiss).toHaveLength(0);

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
      const local = await createNodeSqliteBackend(':memory:', { registry });
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

    // NESTED + SUBTREE declared fields (plan line 156). Mirror of the
    // sqlite-local-search test: `meta.notes` nested scalar path + `profile`
    // subtree; undeclared junk fields (`serial`, `stamp`, `meta.hidden`) stay
    // out of the partition.
    it('indexes a nested declared field and a declared subtree, excluding junk fields', async () => {
      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          indexes: [{ fields: [], fullText: { fields: ['meta.notes', 'profile'] } }],
        },
      ]);
      const local = await createNodeSqliteBackend(':memory:', { registry });
      const client = createGraphClient(local.backend);
      const uid = generateId();
      await client.putNode('tour', uid, {
        meta: { notes: 'nestedword', hidden: 'buriedword' },
        profile: { bio: 'subtreeword', tags: { inner: 'deepword' } },
        serial: '9f2Kq7bN',
        stamp: '2026-07-24T00:00:00Z',
      });

      for (const term of ['nestedword', 'subtreeword', 'deepword']) {
        const hit = await client.fullTextSearch({
          aType: 'tour',
          axbType: 'is',
          query: term,
          limit: 5,
        });
        expect(
          hit.map((r) => r.aUid),
          term,
        ).toEqual([uid]);
      }

      for (const term of ['buriedword', '9f2Kq7bN', '2026']) {
        const miss = await client.fullTextSearch({
          aType: 'tour',
          axbType: 'is',
          query: term,
          limit: 5,
        });
        expect(miss, term).toHaveLength(0);
      }

      for (const term of ['buriedword', '2026']) {
        const viaShared = await client.fullTextSearch({
          aType: 'tour',
          axbType: 'is',
          query: term,
          perTypeStats: false,
          limit: 5,
        });
        expect(
          viaShared.map((r) => r.aUid),
          term,
        ).toEqual([uid]);
      }
      local.close();
    });

    // COEXISTENCE — the PR #37 failure case (plan line 160). Mirror of the
    // sqlite-local-search test: a consumer owns the three shared FTS triggers
    // via `extraTableDDL` (distinctive body, no `_fts_t_`), and the registry
    // declares `IndexSpec.fullText`. After bootstrap + writes + a search the
    // shared trigger bodies must still be the consumer's, and the per-type
    // partition still returns field-filtered results.
    it('freezes consumer-owned shared FTS triggers while per-type search still works', async () => {
      const sharedTriggerBody = (name: string, when: string, row: 'new' | 'old'): string =>
        `CREATE TRIGGER "${name}" ${when} ON "firegraph" BEGIN\n` +
        `  INSERT INTO "consumer_audit" ("doc_id", "trig") VALUES (${row}."doc_id", '${name}');\n` +
        `END`;

      const sharedTriggers: Array<[string, string, 'new' | 'old']> = [
        ['firegraph_fts_ai', 'AFTER INSERT', 'new'],
        ['firegraph_fts_au', 'AFTER UPDATE', 'new'],
        ['firegraph_fts_ad', 'AFTER DELETE', 'old'],
      ];

      const extraTableDDL = (table: string): string[] => {
        if (table !== 'firegraph') return [];
        const stmts = [`CREATE TABLE IF NOT EXISTS "consumer_audit" ("doc_id" TEXT, "trig" TEXT)`];
        for (const [name, when, row] of sharedTriggers) {
          stmts.push(`DROP TRIGGER IF EXISTS "${name}"`, sharedTriggerBody(name, when, row));
        }
        return stmts;
      };

      const registry = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          indexes: [{ fields: [], fullText: { fields: ['title'] } }],
        },
      ]);

      const local = await createNodeSqliteBackend(':memory:', { registry, extraTableDDL });
      const client = createGraphClient(local.backend);
      const uid = generateId();
      await client.putNode('tour', uid, { title: 'coexistword', body: 'ignoredword' });
      await client.putNode('tour', uid, { title: 'coexistword', body: 'ignoredword' });

      const titleHit = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'coexistword',
        limit: 5,
      });
      expect(titleHit.map((r) => r.aUid)).toEqual([uid]);
      const bodyMiss = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'ignoredword',
        limit: 5,
      });
      expect(bodyMiss).toHaveLength(0);

      for (const [name, when, row] of sharedTriggers) {
        const stored = local.db
          .prepare(`SELECT "sql" FROM sqlite_master WHERE "type" = 'trigger' AND "name" = ?`)
          .get(name) as { sql: string };
        expect(stored.sql, name).toBe(sharedTriggerBody(name, when, row));
        expect(stored.sql, name).not.toContain('_fts_t_');
      }

      const audit = local.db.prepare(`SELECT count(*) AS n FROM "consumer_audit"`).get() as {
        n: number;
      };
      expect(audit.n).toBeGreaterThan(0);
      local.close();
    });

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
      const first = await createNodeSqliteBackend(path, { registry: narrow });
      await createGraphClient(first.backend).putNode('tour', uid, {
        title: 'aurora',
        body: 'borealis',
      });
      const miss = await createGraphClient(first.backend).fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'borealis',
        limit: 5,
      });
      expect(miss).toHaveLength(0);
      first.close();

      const wide = createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          indexes: [{ fields: [], fullText: { fields: ['title', 'body'] } }],
        },
      ]);
      const second = await createNodeSqliteBackend(path, { registry: wide });
      const client = createGraphClient(second.backend);
      const hit = await client.fullTextSearch({
        aType: 'tour',
        axbType: 'is',
        query: 'borealis',
        limit: 5,
      });
      expect(hit.map((r) => r.aUid)).toEqual([uid]);

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
        createNodeSqliteBackend(':memory:', { registry, perTypeFtsStats: ['tour'] }),
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
      await expect(createNodeSqliteBackend(':memory:', { registry })).rejects.toMatchObject({
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
      await expect(createNodeSqliteBackend(':memory:', { registry })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    });

    // HARDCODED pre-#37 (0.18.0 / e60e95b) shared FTS DDL + reconciliation
    // literals, pinned by hand rather than re-derived from the builders (which
    // would be a tautology unable to catch a drift in a shared trigger body —
    // the PR #37 clobber class). If you intentionally change the shared DDL,
    // update these literals. Mirror of the sqlite-local-search assertion.
    it('empty config emits only shared FTS DDL (byte-identical to the pinned pre-#37 literals)', () => {
      const table = 'firegraph';
      const ddl = buildLocalSearchDDL(table, new Map());

      const expected = [
        `CREATE TABLE IF NOT EXISTS "firegraph_fts_map" (\n      "id"     INTEGER PRIMARY KEY AUTOINCREMENT,\n      "doc_id" TEXT NOT NULL UNIQUE\n    )`,
        `CREATE VIRTUAL TABLE IF NOT EXISTS "firegraph_fts" USING fts5("text")`,
        `CREATE TRIGGER IF NOT EXISTS "firegraph_fts_ai" AFTER INSERT ON "firegraph" BEGIN\n  INSERT INTO "firegraph_fts_map" ("doc_id") SELECT new."doc_id" WHERE NOT EXISTS (SELECT 1 FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id");\n  DELETE FROM "firegraph_fts" WHERE rowid = (SELECT "id" FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id");\n  INSERT INTO "firegraph_fts" (rowid, "text") VALUES ((SELECT "id" FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id"), (SELECT coalesce(group_concat("value", ' '), '') FROM json_tree(coalesce(new."data", '{}')) WHERE "type" = 'text'));\nEND`,
        `CREATE TRIGGER IF NOT EXISTS "firegraph_fts_au" AFTER UPDATE ON "firegraph" BEGIN\n  INSERT INTO "firegraph_fts_map" ("doc_id") SELECT new."doc_id" WHERE NOT EXISTS (SELECT 1 FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id");\n  DELETE FROM "firegraph_fts" WHERE rowid = (SELECT "id" FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id");\n  INSERT INTO "firegraph_fts" (rowid, "text") VALUES ((SELECT "id" FROM "firegraph_fts_map" WHERE "doc_id" = new."doc_id"), (SELECT coalesce(group_concat("value", ' '), '') FROM json_tree(coalesce(new."data", '{}')) WHERE "type" = 'text'));\nEND`,
        `CREATE TRIGGER IF NOT EXISTS "firegraph_fts_ad" AFTER DELETE ON "firegraph" BEGIN\n  DELETE FROM "firegraph_fts" WHERE rowid = (SELECT "id" FROM "firegraph_fts_map" WHERE "doc_id" = old."doc_id");\n  DELETE FROM "firegraph_fts_map" WHERE "doc_id" = old."doc_id";\nEND`,
        `DELETE FROM "firegraph_fts" WHERE rowid IN (\n      SELECT m."id" FROM "firegraph_fts_map" m LEFT JOIN "firegraph" t ON t."doc_id" = m."doc_id"\n      WHERE t."doc_id" IS NULL\n    )`,
        `DELETE FROM "firegraph_fts_map" WHERE "doc_id" NOT IN (SELECT "doc_id" FROM "firegraph")`,
        `INSERT OR IGNORE INTO "firegraph_fts_map" ("doc_id") SELECT "doc_id" FROM "firegraph"`,
        `INSERT INTO "firegraph_fts" (rowid, "text")\n      SELECT m."id", (SELECT coalesce(group_concat("value", ' '), '') FROM json_tree(coalesce(t."data", '{}')) WHERE "type" = 'text')\n      FROM "firegraph" t JOIN "firegraph_fts_map" m ON m."doc_id" = t."doc_id"\n      WHERE m."id" NOT IN (SELECT rowid FROM "firegraph_fts")`,
      ];
      expect(ddl).toEqual(expected);

      expect(ddl).toEqual([...buildFtsDDL(table), ...buildFtsSyncStatements(table)]);
      expect(ddl.some((s) => s.includes('_fts_t_'))).toBe(false);
      expect(
        ddl
          .filter((s) => s.includes('TRIGGER'))
          .every((s) => s.includes('CREATE TRIGGER IF NOT EXISTS')),
      ).toBe(true);
    });

    it('does not create a _fts_cfg table for a default (empty-config) backend', async () => {
      const local = await createNodeSqliteBackend(':memory:');
      const client = createGraphClient(local.backend);
      await client.putNode('tour', generateId(), { name: 'plain' });
      await client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'plain', limit: 5 });
      expect(tableNames(local.db)).not.toContain(ftsCfgTableName('firegraph'));
      local.close();
    });

    it('heals a legacy folded shared FTS trigger on reopen', async () => {
      const path = tempDbPath('legacy-heal');
      const first = await createNodeSqliteBackend(path);
      await createGraphClient(first.backend).putNode('tour', generateId(), { name: 'relic' });
      first.close();

      const raw = new DatabaseSync(path);
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

      const second = await createNodeSqliteBackend(path);
      const client = createGraphClient(second.backend);
      await client.fullTextSearch({ aType: 'tour', axbType: 'is', query: 'relic', limit: 5 });

      const healed = second.db
        .prepare(`SELECT "sql" FROM sqlite_master WHERE "name" = 'firegraph_fts_ai'`)
        .get() as { sql: string };
      expect(healed.sql).not.toContain('_fts_t_');
      const canonicalAi = sharedFtsTriggerDefs('firegraph').find(
        (d) => d.name === 'firegraph_fts_ai',
      );
      expect(healed.sql).toBe(
        canonicalAi?.statement.replace('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER'),
      );

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

    it('sweeps _fts_cfg rows for a cascade-dropped subgraph', async () => {
      const registry = createRegistry([
        {
          aType: 'stop',
          axbType: 'is',
          bType: 'stop',
          indexes: [{ fields: [], fullText: { fields: ['text'] } }],
        },
      ]);
      const { backend, db, close } = await createNodeSqliteBackend(':memory:', { registry });
      const client = createGraphClient(backend);
      const parentUid = generateId();
      await client.putNode('tour', parentUid, { name: 'host' });
      const sub = client.subgraph(parentUid, 'stops');
      await sub.putNode('stop', generateId(), { text: 'reef' });
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
  },
);
