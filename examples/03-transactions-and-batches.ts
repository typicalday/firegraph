/**
 * Transactions and batches — atomic operations with full validation
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/03-transactions-and-batches.ts
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createGraphClient, createRegistry, generateId } from '../src/index.js';

initializeApp({ projectId: 'demo-firegraph' });
const db = getFirestore();

// ── Schema + Registry ───────────────────────────────────────────

const tourDataSchema = z.object({
  name: z.string().min(1),
  region: z.string(),
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
});

const registry = createRegistry([
  { aType: 'tour',      abType: 'is', bType: 'tour',      dataSchema: tourDataSchema,      description: 'Tour entity' },
  { aType: 'departure', abType: 'is', bType: 'departure', dataSchema: departureDataSchema, description: 'Departure entity' },
  { aType: 'rider',     abType: 'is', bType: 'rider',     dataSchema: riderDataSchema,     description: 'Rider entity' },
  { aType: 'tour',      abType: 'hasDeparture', bType: 'departure', dataSchema: orderedEdgeData, description: 'Tour has a departure' },
  { aType: 'departure', abType: 'hasRider',     bType: 'rider',     dataSchema: bookingEdgeData, description: 'Departure has a rider' },
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

  const riders = await g.findEdges({ aUid: 'dep1', abType: 'hasRider' });
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
