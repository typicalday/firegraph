/**
 * Basic CRUD — nodes and edges with registry validation
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/01-basic-crud.ts
 */
import { Firestore } from '@google-cloud/firestore';

import { createGraphClient, createRegistry, generateId } from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// ── JSON Schema definitions ─────────────────────────────────────

const tourSchema = {
  type: 'object',
  required: ['name', 'difficulty', 'maxRiders'],
  properties: {
    name: { type: 'string', minLength: 1 },
    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    maxRiders: { type: 'integer', exclusiveMinimum: 0 },
  },
  additionalProperties: false,
};

const departureSchema = {
  type: 'object',
  required: ['date', 'maxCapacity', 'registeredRiders'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    maxCapacity: { type: 'integer', exclusiveMinimum: 0 },
    registeredRiders: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const riderSchema = {
  type: 'object',
  required: ['displayName', 'email'],
  properties: {
    displayName: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
  },
  additionalProperties: false,
};

const orderedEdgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
};

const bookingEdgeSchema = {
  type: 'object',
  required: ['status', 'bookedAt'],
  properties: {
    status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] },
    bookedAt: { type: 'string' },
  },
  additionalProperties: false,
};

// ── Registry ────────────────────────────────────────────────────

const registry = createRegistry([
  // Nodes
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    jsonSchema: tourSchema,
    description: 'Tour entity',
  },
  {
    aType: 'departure',
    axbType: 'is',
    bType: 'departure',
    jsonSchema: departureSchema,
    description: 'Departure entity',
  },
  {
    aType: 'rider',
    axbType: 'is',
    bType: 'rider',
    jsonSchema: riderSchema,
    description: 'Rider entity',
  },

  // Edges
  {
    aType: 'tour',
    axbType: 'hasDeparture',
    bType: 'departure',
    jsonSchema: orderedEdgeSchema,
    description: 'Tour has a departure date',
  },
  {
    aType: 'departure',
    axbType: 'hasRider',
    bType: 'rider',
    jsonSchema: bookingEdgeSchema,
    description: 'Departure has a booked rider',
  },
]);

const g = createGraphClient(db, 'examples/crud/graph', { registry });

async function main() {
  // ── Create nodes ──────────────────────────────────────────────
  const tourId = generateId();
  const depId = generateId();
  const riderId = generateId();

  await g.putNode('tour', tourId, {
    name: 'Dolomites Classic',
    difficulty: 'hard',
    maxRiders: 30,
  });

  await g.putNode('departure', depId, {
    date: '2025-07-15',
    maxCapacity: 30,
    registeredRiders: 0,
  });

  await g.putNode('rider', riderId, {
    displayName: 'Jamie Chen',
    email: 'jamie@example.com',
  });

  console.log('Created nodes:', { tourId, depId, riderId });

  // ── Read a node ───────────────────────────────────────────────
  const tour = await g.getNode(tourId);
  console.log('Tour:', tour?.data);

  // ── Create edges ──────────────────────────────────────────────
  await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, {
    order: 0,
  });

  await g.putEdge('departure', depId, 'hasRider', 'rider', riderId, {
    status: 'confirmed',
    bookedAt: new Date().toISOString(),
  });

  console.log('Created edges');

  // ── Read an edge ──────────────────────────────────────────────
  const edge = await g.getEdge(tourId, 'hasDeparture', depId);
  console.log('Edge data:', edge?.data);

  // ── Check existence ───────────────────────────────────────────
  const exists = await g.edgeExists(tourId, 'hasDeparture', depId);
  console.log('Edge exists:', exists);

  // ── Update a node ─────────────────────────────────────────────
  await g.updateNode(depId, { 'data.registeredRiders': 1 });
  const updated = await g.getNode(depId);
  console.log('Updated departure:', updated?.data);

  // ── Delete ────────────────────────────────────────────────────
  await g.removeEdge(depId, 'hasRider', riderId);
  await g.removeNode(riderId);
  console.log('Removed rider and booking edge');

  const gone = await g.getNode(riderId);
  console.log('Rider after delete:', gone); // null
}

main().catch(console.error);
