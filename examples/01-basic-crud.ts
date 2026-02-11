/**
 * Basic CRUD — nodes and edges with registry validation
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/01-basic-crud.ts
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createGraphClient, createRegistry, generateId } from '../src/index.js';

initializeApp({ projectId: 'demo-firegraph' });
const db = getFirestore();

// ── Schema definitions ──────────────────────────────────────────

const tourDataSchema = z.object({
  name: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  maxRiders: z.number().int().positive(),
});

const departureDataSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxCapacity: z.number().int().positive(),
  registeredRiders: z.number().int().min(0),
});

const riderDataSchema = z.object({
  displayName: z.string().min(1),
  email: z.string().email(),
});

const orderedEdgeData = z.object({
  order: z.number().int().min(0),
});

const bookingEdgeData = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled']),
  bookedAt: z.string(),
});

// ── Registry ────────────────────────────────────────────────────

const registry = createRegistry([
  // Nodes
  { aType: 'tour',      abType: 'is', bType: 'tour',      dataSchema: tourDataSchema,      description: 'Tour entity' },
  { aType: 'departure', abType: 'is', bType: 'departure', dataSchema: departureDataSchema, description: 'Departure entity' },
  { aType: 'rider',     abType: 'is', bType: 'rider',     dataSchema: riderDataSchema,     description: 'Rider entity' },

  // Edges
  { aType: 'tour',      abType: 'hasDeparture', bType: 'departure', dataSchema: orderedEdgeData, description: 'Tour has a departure date' },
  { aType: 'departure', abType: 'hasRider',     bType: 'rider',     dataSchema: bookingEdgeData, description: 'Departure has a booked rider' },
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
