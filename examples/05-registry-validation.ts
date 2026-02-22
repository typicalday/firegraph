/**
 * Schema registry — how validation works end-to-end
 *
 * Shows that firegraph validates the full document on every write:
 * - Triple (aType, abType, bType) is validated by the registry lookup
 * - Data payload is validated by the Zod schema
 * - UIDs are user-controlled strings
 * - Timestamps are set by the library
 *
 * Any write that doesn't match a registered triple + valid data is rejected
 * BEFORE reaching Firestore.
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/05-registry-validation.ts
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  createGraphClient,
  createRegistry,
  ValidationError,
  RegistryViolationError,
} from '../src/index.js';

initializeApp({ projectId: 'demo-firegraph' });
const db = getFirestore();

// ═══════════════════════════════════════════════════════════════
// 1. Define node data schemas
// ═══════════════════════════════════════════════════════════════

const tourDataSchema = z.object({
  name: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  maxRiders: z.number().int().positive(),
});

const departureDataSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  maxCapacity: z.number().int().positive(),
  registeredRiders: z.number().int().min(0),
  status: z.enum(['draft', 'open', 'closed', 'completed']),
});

const userDataSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  roles: z.array(z.enum(['customer', 'tourLeader', 'admin'])),
  authProvider: z.enum(['email', 'google', 'strava']),
});

const bookingDataSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']),
  bookingReference: z.string(),
  totalAmount: z.number().positive(),
  currency: z.string().length(3),
  lineItems: z.array(z.object({
    description: z.string(),
    quantity: z.number().int().positive(),
    unitPrice: z.number().positive(),
  })),
});

const riderDataSchema = z.object({
  displayName: z.string().min(1),
  dietaryRequirements: z.string().optional(),
  emergencyContact: z.object({
    name: z.string(),
    phone: z.string(),
  }).optional(),
});

const operatorDataSchema = z.object({
  companyName: z.string().min(1),
  country: z.string().length(2),
  contactEmail: z.string().email(),
});

// ═══════════════════════════════════════════════════════════════
// 2. Define edge data schemas
// ═══════════════════════════════════════════════════════════════

const orderedEdgeData = z.object({
  order: z.number().int().min(0),
});

const emptyEdgeData = z.object({}).strict();

const primaryContactEdgeData = z.object({
  isPrimaryContact: z.boolean(),
});

const operatorAgreementEdgeData = z.object({
  netCostPerRider: z.number().positive(),
  currency: z.string().length(3),
});

// ═══════════════════════════════════════════════════════════════
// 3. Build the registry — every node and edge must be declared
// ═══════════════════════════════════════════════════════════════

const registry = createRegistry([
  // Node types (abType: 'is')
  { aType: 'tour',      abType: 'is', bType: 'tour',      dataSchema: tourDataSchema,      description: 'Tour entity' },
  { aType: 'departure', abType: 'is', bType: 'departure', dataSchema: departureDataSchema, description: 'Departure entity' },
  { aType: 'user',      abType: 'is', bType: 'user',      dataSchema: userDataSchema,      description: 'User entity' },
  { aType: 'booking',   abType: 'is', bType: 'booking',   dataSchema: bookingDataSchema,   description: 'Booking entity' },
  { aType: 'rider',     abType: 'is', bType: 'rider',     dataSchema: riderDataSchema,     description: 'Rider on a booking' },
  { aType: 'operator',  abType: 'is', bType: 'operator',  dataSchema: operatorDataSchema,  description: 'Operator partner' },

  // Edge types (inverseLabel is a display-only label for when viewing incoming edges)
  { aType: 'tour',    abType: 'hasDeparture',        bType: 'departure', dataSchema: orderedEdgeData,          description: 'Tour has a departure date',   inverseLabel: 'departureOf' },
  { aType: 'tour',    abType: 'hasItineraryDay',     bType: 'tour',      dataSchema: orderedEdgeData,          description: 'Tour has an itinerary day',   inverseLabel: 'itineraryDayOf' },
  { aType: 'tour',    abType: 'fulfilledByOperator', bType: 'operator',  dataSchema: operatorAgreementEdgeData, description: 'Tour fulfilled by operator', inverseLabel: 'fulfils' },
  { aType: 'user',    abType: 'placedBooking',       bType: 'booking',   dataSchema: emptyEdgeData,            description: 'User placed a booking',       inverseLabel: 'placedBy' },
  { aType: 'booking', abType: 'bookedForTour',       bType: 'tour',      dataSchema: emptyEdgeData,            description: 'Booking is for a tour',       inverseLabel: 'hasBooking' },
  { aType: 'booking', abType: 'bookedForDeparture',  bType: 'departure', dataSchema: emptyEdgeData,            description: 'Booking is for a departure',  inverseLabel: 'hasBooking' },
  { aType: 'booking', abType: 'includesRider',       bType: 'rider',     dataSchema: primaryContactEdgeData,   description: 'Booking includes a rider',    inverseLabel: 'riderOn' },
]);

const g = createGraphClient(db, 'examples/registry/graph', { registry });

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // Valid operations — pass both triple check and data validation
  // ═══════════════════════════════════════════════════════════════
  await g.putNode('tour', 'tour1', {
    name: 'Dolomites Classic',
    difficulty: 'hard',
    maxRiders: 30,
  });
  console.log('tour1 created');

  await g.putNode('departure', 'dep1', {
    date: '2025-07-15',
    maxCapacity: 30,
    registeredRiders: 0,
    status: 'open',
  });
  console.log('dep1 created');

  await g.putNode('user', 'user1', {
    email: 'jamie@example.com',
    displayName: 'Jamie Chen',
    roles: ['customer'],
    authProvider: 'google',
  });
  console.log('user1 created');

  await g.putNode('booking', 'booking1', {
    status: 'confirmed',
    bookingReference: 'BK-2025-001',
    totalAmount: 2500,
    currency: 'EUR',
    lineItems: [
      { description: 'Tour spot', quantity: 1, unitPrice: 2500 },
    ],
  });
  console.log('booking1 created');

  // Valid edges
  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
  await g.putEdge('user', 'user1', 'placedBooking', 'booking', 'booking1', {});
  await g.putEdge('booking', 'booking1', 'bookedForTour', 'tour', 'tour1', {});
  await g.putEdge('booking', 'booking1', 'bookedForDeparture', 'departure', 'dep1', {});
  console.log('Edges created');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // Invalid data — Zod catches bad values BEFORE Firestore write
  // ═══════════════════════════════════════════════════════════════
  try {
    await g.putNode('tour', 'bad-tour', {
      name: '',              // fails z.string().min(1)
      difficulty: 'extreme', // fails z.enum()
      maxRiders: -5,         // fails z.number().positive()
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('ValidationError — bad tour data:');
      console.log('  Code:', err.code);
      console.log('  Message:', err.message);
    }
  }

  // Verify nothing was written
  const badTour = await g.getNode('bad-tour');
  console.log('  Written to Firestore:', badTour !== null); // false
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // Unregistered triple — rejected before data validation
  // ═══════════════════════════════════════════════════════════════
  try {
    await g.putEdge('user', 'user1', 'friendsWith', 'user', 'user2', {});
  } catch (err) {
    if (err instanceof RegistryViolationError) {
      console.log('RegistryViolationError — unregistered edge type:');
      console.log('  Code:', err.code);
      console.log('  Message:', err.message);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // Strict edge data — extra fields rejected
  // ═══════════════════════════════════════════════════════════════
  try {
    // emptyEdgeData uses .strict(), so extra fields are rejected
    await g.putEdge('user', 'user1', 'placedBooking', 'booking', 'booking2', {
      sneakyField: 'should not be here',
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('ValidationError — strict edge rejects extra fields:');
      console.log('  Message:', err.message);
    }
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // Wrong types in edge data
  // ═══════════════════════════════════════════════════════════════
  try {
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', {
      order: 'first', // should be number
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('ValidationError — bad edge data:');
      console.log('  Message:', err.message);
    }
  }
}

main().catch(console.error);
