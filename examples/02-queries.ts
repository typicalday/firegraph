/**
 * Querying edges — forward, reverse, type-scoped, with limit/orderBy
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/02-queries.ts
 */
import { Firestore } from '@google-cloud/firestore';
import { createGraphClient, createRegistry } from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// ── JSON Schema + Registry ──────────────────────────────────────

const tourSchema = {
  type: 'object',
  required: ['name', 'region'],
  properties: {
    name: { type: 'string', minLength: 1 },
    region: { type: 'string' },
  },
  additionalProperties: false,
};

const departureSchema = {
  type: 'object',
  required: ['date'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
  additionalProperties: false,
};

const orderedEdgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
};

const registry = createRegistry([
  { aType: 'tour',      axbType: 'is', bType: 'tour',      jsonSchema: tourSchema,      description: 'Tour entity' },
  { aType: 'departure', axbType: 'is', bType: 'departure', jsonSchema: departureSchema, description: 'Departure entity' },
  { aType: 'tour',      axbType: 'hasDeparture', bType: 'departure', jsonSchema: orderedEdgeSchema, description: 'Tour has a departure' },
]);

const g = createGraphClient(db, 'examples/queries/graph', { registry });

async function main() {
  // ── Seed data ─────────────────────────────────────────────────
  await g.putNode('tour', 'tour1', { name: 'Dolomites Classic', region: 'alps' });
  await g.putNode('tour', 'tour2', { name: 'Coastal Explorer', region: 'mediterranean' });
  await g.putNode('departure', 'dep1', { date: '2025-07-15' });
  await g.putNode('departure', 'dep2', { date: '2025-08-01' });
  await g.putNode('departure', 'dep3', { date: '2025-09-10' });

  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', { order: 2 });
  await g.putEdge('tour', 'tour2', 'hasDeparture', 'departure', 'dep1', { order: 0 });

  // ── Forward lookup: all departures of tour1 ───────────────────
  const tour1Deps = await g.findEdges({
    aUid: 'tour1',
    axbType: 'hasDeparture',
  });
  console.log(
    'tour1 departures:',
    tour1Deps.map((e) => e.bUid),
  );
  // → ['dep1', 'dep2', 'dep3']

  // ── Reverse lookup: which tours include dep1? ─────────────────
  const dep1Tours = await g.findEdges({
    axbType: 'hasDeparture',
    bUid: 'dep1',
  });
  console.log(
    'Tours with dep1:',
    dep1Tours.map((e) => e.aUid),
  );
  // → ['tour1', 'tour2']

  // ── Type-scoped: all hasDeparture edges from any tour ─────────
  const allTourDeps = await g.findEdges({
    aType: 'tour',
    axbType: 'hasDeparture',
  });
  console.log('All tour→departure edges:', allTourDeps.length);
  // → 4

  // ── With limit ────────────────────────────────────────────────
  const limited = await g.findEdges({
    aUid: 'tour1',
    axbType: 'hasDeparture',
    limit: 2,
  });
  console.log(
    'First 2 departures:',
    limited.map((e) => e.bUid),
  );

  // ── Exact edge lookup (uses direct doc get — fastest) ─────────
  const exact = await g.findEdges({
    aUid: 'tour1',
    axbType: 'hasDeparture',
    bUid: 'dep1',
  });
  console.log('Exact edge:', exact.length === 1 ? 'found' : 'not found');

  // ── Find all nodes of a type ──────────────────────────────────
  const allTours = await g.findNodes({ aType: 'tour' });
  console.log(
    'All tours:',
    allTours.map((n) => n.data.name),
  );
}

main().catch(console.error);
