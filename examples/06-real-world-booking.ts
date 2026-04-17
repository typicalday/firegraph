/**
 * Real-world scenario: tour booking platform
 *
 * Models a cycling tour platform where:
 * - Tours have multiple departure dates
 * - Departures have capacity-limited rider slots
 * - Users place bookings that include riders
 * - Queries need to fan out across the graph
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/06-real-world-booking.ts
 */
import { Firestore } from '@google-cloud/firestore';

import { createGraphClient, createRegistry, createTraversal, generateId } from '../src/index.js';
import type { GraphClient, GraphTransaction } from '../src/types.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// ── JSON Schemas ────────────────────────────────────────────────

const tourSchema = {
  type: 'object',
  required: ['name', 'difficulty'],
  properties: {
    name: { type: 'string', minLength: 1 },
    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
  },
  additionalProperties: false,
};

const departureSchema = {
  type: 'object',
  required: ['date', 'capacity', 'registeredRiders'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    capacity: { type: 'integer', exclusiveMinimum: 0 },
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

const riderEdgeSchema = {
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
  {
    aType: 'tour',
    axbType: 'hasDeparture',
    bType: 'departure',
    jsonSchema: orderedEdgeSchema,
    description: 'Tour has a departure',
  },
  {
    aType: 'departure',
    axbType: 'hasRider',
    bType: 'rider',
    jsonSchema: riderEdgeSchema,
    description: 'Departure has a rider',
  },
]);

const g = createGraphClient(db, 'examples/booking/graph', { registry });

// ── Domain helpers ───────────────────────────────────────────────

async function createTour(name: string, difficulty: 'easy' | 'medium' | 'hard') {
  const id = generateId();
  await g.putNode('tour', id, { name, difficulty });
  return id;
}

async function addDeparture(tourId: string, date: string, capacity: number) {
  const id = generateId();
  await g.putNode('departure', id, { date, capacity, registeredRiders: 0 });
  await g.putEdge('tour', tourId, 'hasDeparture', 'departure', id, {
    order: (await g.findEdges({ aUid: tourId, axbType: 'hasDeparture' })).length,
  });
  return id;
}

async function registerRider(displayName: string, email: string) {
  const id = generateId();
  await g.putNode('rider', id, { displayName, email });
  return id;
}

async function bookRider(
  client: GraphClient,
  depId: string,
  riderId: string,
): Promise<{ success: boolean; reason?: string }> {
  return client.runTransaction(async (tx: GraphTransaction) => {
    const dep = await tx.getNode(depId);
    if (!dep) return { success: false, reason: 'departure not found' };

    const registered = dep.data.registeredRiders as number;
    const capacity = dep.data.capacity as number;

    if (registered >= capacity) {
      return { success: false, reason: 'departure full' };
    }

    const existing = await tx.edgeExists(depId, 'hasRider', riderId);
    if (existing) {
      return { success: false, reason: 'already booked' };
    }

    await tx.putEdge('departure', depId, 'hasRider', 'rider', riderId, {
      status: 'confirmed',
      bookedAt: new Date().toISOString(),
    });
    await tx.updateNode(depId, {
      'data.registeredRiders': registered + 1,
    });

    return { success: true };
  });
}

// ── Main scenario ────────────────────────────────────────────────

async function main() {
  console.log('=== Setting up tour platform ===\n');

  const dolomites = await createTour('Dolomites Classic', 'hard');
  const alps = await createTour('Alps Explorer', 'medium');
  console.log('Tours created');

  const dolJul = await addDeparture(dolomites, '2025-07-15', 3);
  const dolAug = await addDeparture(dolomites, '2025-08-01', 2);
  const alpSep = await addDeparture(alps, '2025-09-10', 5);
  console.log('Departures added');

  const jamie = await registerRider('Jamie Chen', 'jamie@example.com');
  const sam = await registerRider('Sam Okafor', 'sam@example.com');
  const priya = await registerRider('Priya Patel', 'priya@example.com');
  const luca = await registerRider('Luca Moretti', 'luca@example.com');
  console.log('Riders registered\n');

  // ── Book riders into departures ───────────────────────────────
  console.log('=== Booking riders ===\n');

  const bookings = [
    { dep: dolJul, rider: jamie, label: 'Jamie → Dolomites Jul' },
    { dep: dolJul, rider: sam, label: 'Sam → Dolomites Jul' },
    { dep: dolJul, rider: priya, label: 'Priya → Dolomites Jul' },
    { dep: dolAug, rider: jamie, label: 'Jamie → Dolomites Aug' },
    { dep: dolAug, rider: luca, label: 'Luca → Dolomites Aug' },
    { dep: alpSep, rider: sam, label: 'Sam → Alps Sep' },
    { dep: alpSep, rider: priya, label: 'Priya → Alps Sep' },
  ];

  for (const { dep, rider, label } of bookings) {
    const result = await bookRider(g, dep, rider);
    console.log(`  ${label}: ${result.success ? 'booked' : result.reason}`);
  }

  // Try overbooking (dolJul capacity=3, already full)
  const overbook = await bookRider(g, dolJul, luca);
  console.log(`  Luca → Dolomites Jul: ${overbook.success ? 'booked' : overbook.reason}`);

  // Try double booking
  const double = await bookRider(g, dolJul, jamie);
  console.log(`  Jamie → Dolomites Jul (again): ${double.success ? 'booked' : double.reason}`);
  console.log();

  // ── Multi-hop queries ─────────────────────────────────────────
  console.log('=== Queries ===\n');

  // All riders for a tour (2 hops)
  const dolomitesRiders = await createTraversal(g, dolomites)
    .follow('hasDeparture')
    .follow('hasRider')
    .run({ returnIntermediates: true });

  console.log('All Dolomites riders:');
  console.log(`  Departures: ${dolomitesRiders.hops[0].edges.length}`);
  console.log(`  Rider bookings: ${dolomitesRiders.nodes.length}`);
  console.log(`  Firestore reads: ${dolomitesRiders.totalReads}`);
  console.log();

  // Reverse: which tours is Jamie booked on?
  const jamieTours = await createTraversal(g, jamie)
    .follow('hasRider', { direction: 'reverse' })
    .follow('hasDeparture', { direction: 'reverse' })
    .run({ returnIntermediates: true });

  console.log('Tours Jamie is booked on:');
  console.log(`  Departures: ${jamieTours.hops[0].edges.length}`);
  console.log(`  Tours: ${jamieTours.nodes.length}`);
  for (const tourEdge of jamieTours.nodes) {
    const tour = await g.getNode(tourEdge.aUid);
    console.log(`    - ${tour?.data.name}`);
  }
  console.log();

  // Confirmed riders only (with filter)
  const confirmedOnly = await createTraversal(g, dolomites)
    .follow('hasDeparture')
    .follow('hasRider', {
      filter: (e) => e.data.status === 'confirmed',
    })
    .run();

  console.log('Confirmed Dolomites riders:', confirmedOnly.nodes.length);

  // First departure only (with limit)
  const firstDep = await createTraversal(g, dolomites)
    .follow('hasDeparture', { limit: 1 })
    .follow('hasRider')
    .run();

  console.log('Riders on first departure:', firstDep.nodes.length);

  // Budget-limited
  const budgeted = await createTraversal(g, dolomites)
    .follow('hasDeparture')
    .follow('hasRider')
    .run({ maxReads: 2 });

  console.log(
    `Budget-limited (maxReads=2): ${budgeted.totalReads} reads, truncated=${budgeted.truncated}`,
  );
}

main().catch(console.error);
