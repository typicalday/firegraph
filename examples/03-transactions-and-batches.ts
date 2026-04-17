/**
 * Transactions and batches — atomic operations with full validation
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/03-transactions-and-batches.ts
 */
import { Firestore } from '@google-cloud/firestore';

import { createGraphClient, createRegistry, generateId } from '../src/index.js';

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
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] },
  },
  additionalProperties: false,
};

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
    jsonSchema: bookingEdgeSchema,
    description: 'Departure has a rider',
  },
]);

const g = createGraphClient(db, 'examples/txn/graph', { registry });

async function main() {
  // ── Seed ──────────────────────────────────────────────────────
  await g.putNode('departure', 'dep1', {
    date: '2025-07-15',
    maxCapacity: 3,
    registeredRiders: 0,
  });

  // ═══════════════════════════════════════════════════════════════
  // Transaction: read-then-write (conditional booking)
  // ═══════════════════════════════════════════════════════════════
  async function bookRider(riderId: string, riderName: string) {
    return g.runTransaction(async (tx) => {
      const dep = await tx.getNode('dep1');
      if (!dep) throw new Error('Departure not found');

      const count = dep.data.registeredRiders as number;
      const max = dep.data.maxCapacity as number;

      if (count >= max) {
        return { booked: false, reason: 'full' };
      }

      // Create rider node + edge + update counter — all atomic
      await tx.putNode('rider', riderId, {
        displayName: riderName,
        email: `${riderName.toLowerCase().replace(' ', '.')}@example.com`,
      });
      await tx.putEdge('departure', 'dep1', 'hasRider', 'rider', riderId, {
        status: 'confirmed',
      });
      await tx.updateNode('dep1', {
        'data.registeredRiders': count + 1,
      });

      return { booked: true, slot: count + 1 };
    });
  }

  // Book three riders (should all succeed)
  console.log('Rider 1:', await bookRider(generateId(), 'Jamie Chen'));
  console.log('Rider 2:', await bookRider(generateId(), 'Sam Okafor'));
  console.log('Rider 3:', await bookRider(generateId(), 'Priya Patel'));

  // Fourth booking should fail (capacity = 3)
  console.log('Rider 4:', await bookRider(generateId(), 'Luca Moretti'));
  // → { booked: false, reason: 'full' }

  // Verify final state
  const dep = await g.getNode('dep1');
  console.log('Registered riders:', dep?.data.registeredRiders);

  const riders = await g.findEdges({ aUid: 'dep1', axbType: 'hasRider' });
  console.log('Booked riders:', riders.length);

  // ═══════════════════════════════════════════════════════════════
  // Batch: bulk write with atomic commit
  // ═══════════════════════════════════════════════════════════════
  const batch = g.batch();

  const tourIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = generateId();
    tourIds.push(id);
    await batch.putNode('tour', id, {
      name: `Tour ${i + 1}`,
      region: 'alps',
    });
  }

  for (const tourId of tourIds) {
    await batch.putEdge('tour', tourId, 'hasDeparture', 'departure', 'dep1', {
      order: 0,
    });
  }

  // Nothing is written until commit()
  await batch.commit();
  console.log('Batch committed: 5 tours + 5 edges');

  const allTours = await g.findNodes({ aType: 'tour' });
  console.log('Total tours in graph:', allTours.length);
}

main().catch(console.error);
