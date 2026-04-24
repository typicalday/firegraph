/**
 * Schema registry — how validation works end-to-end
 *
 * Shows that firegraph validates the full document on every write:
 * - Triple (aType, axbType, bType) is validated by the registry lookup
 * - Data payload is validated by JSON Schema (via @cfworker/json-schema, draft 2020-12)
 * - UIDs are user-controlled strings
 * - Timestamps are set by the library
 *
 * Any write that doesn't match a registered triple + valid data is rejected
 * BEFORE reaching Firestore.
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/05-registry-validation.ts
 */
import { Firestore } from '@google-cloud/firestore';

import {
  createGraphClient,
  createRegistry,
  RegistryViolationError,
  ValidationError,
} from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// ═══════════════════════════════════════════════════════════════
// 1. Define node data schemas (JSON Schema)
// ═══════════════════════════════════════════════════════════════

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
  required: ['date', 'maxCapacity', 'registeredRiders', 'status'],
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    maxCapacity: { type: 'integer', exclusiveMinimum: 0 },
    registeredRiders: { type: 'integer', minimum: 0 },
    status: { type: 'string', enum: ['draft', 'open', 'closed', 'completed'] },
  },
  additionalProperties: false,
};

const userSchema = {
  type: 'object',
  required: ['email', 'displayName', 'roles', 'authProvider'],
  properties: {
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string', minLength: 1 },
    roles: { type: 'array', items: { type: 'string', enum: ['customer', 'tourLeader', 'admin'] } },
    authProvider: { type: 'string', enum: ['email', 'google', 'strava'] },
  },
  additionalProperties: false,
};

const bookingSchema = {
  type: 'object',
  required: ['status', 'bookingReference', 'totalAmount', 'currency', 'lineItems'],
  properties: {
    status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed'] },
    bookingReference: { type: 'string' },
    totalAmount: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['description', 'quantity', 'unitPrice'],
        properties: {
          description: { type: 'string' },
          quantity: { type: 'integer', exclusiveMinimum: 0 },
          unitPrice: { type: 'number', exclusiveMinimum: 0 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const riderSchema = {
  type: 'object',
  required: ['displayName'],
  properties: {
    displayName: { type: 'string', minLength: 1 },
    dietaryRequirements: { type: 'string' },
    emergencyContact: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
      },
    },
  },
  additionalProperties: false,
};

const operatorSchema = {
  type: 'object',
  required: ['companyName', 'country', 'contactEmail'],
  properties: {
    companyName: { type: 'string', minLength: 1 },
    country: { type: 'string', minLength: 2, maxLength: 2 },
    contactEmail: { type: 'string', format: 'email' },
  },
  additionalProperties: false,
};

// ═══════════════════════════════════════════════════════════════
// 2. Define edge data schemas
// ═══════════════════════════════════════════════════════════════

const orderedEdgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
};

const emptyEdgeSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const primaryContactEdgeSchema = {
  type: 'object',
  required: ['isPrimaryContact'],
  properties: { isPrimaryContact: { type: 'boolean' } },
  additionalProperties: false,
};

const operatorAgreementEdgeSchema = {
  type: 'object',
  required: ['netCostPerRider', 'currency'],
  properties: {
    netCostPerRider: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
  },
  additionalProperties: false,
};

// ═══════════════════════════════════════════════════════════════
// 3. Build the registry — every node and edge must be declared
// ═══════════════════════════════════════════════════════════════

const registry = createRegistry([
  // Node types (axbType: 'is')
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
    aType: 'user',
    axbType: 'is',
    bType: 'user',
    jsonSchema: userSchema,
    description: 'User entity',
  },
  {
    aType: 'booking',
    axbType: 'is',
    bType: 'booking',
    jsonSchema: bookingSchema,
    description: 'Booking entity',
  },
  {
    aType: 'rider',
    axbType: 'is',
    bType: 'rider',
    jsonSchema: riderSchema,
    description: 'Rider on a booking',
  },
  {
    aType: 'operator',
    axbType: 'is',
    bType: 'operator',
    jsonSchema: operatorSchema,
    description: 'Operator partner',
  },

  // Edge types (inverseLabel is a display-only label for when viewing incoming edges)
  {
    aType: 'tour',
    axbType: 'hasDeparture',
    bType: 'departure',
    jsonSchema: orderedEdgeSchema,
    description: 'Tour has a departure date',
    inverseLabel: 'departureOf',
  },
  {
    aType: 'tour',
    axbType: 'hasItineraryDay',
    bType: 'tour',
    jsonSchema: orderedEdgeSchema,
    description: 'Tour has an itinerary day',
    inverseLabel: 'itineraryDayOf',
  },
  {
    aType: 'tour',
    axbType: 'fulfilledByOperator',
    bType: 'operator',
    jsonSchema: operatorAgreementEdgeSchema,
    description: 'Tour fulfilled by operator',
    inverseLabel: 'fulfils',
  },
  {
    aType: 'user',
    axbType: 'placedBooking',
    bType: 'booking',
    jsonSchema: emptyEdgeSchema,
    description: 'User placed a booking',
    inverseLabel: 'placedBy',
  },
  {
    aType: 'booking',
    axbType: 'bookedForTour',
    bType: 'tour',
    jsonSchema: emptyEdgeSchema,
    description: 'Booking is for a tour',
    inverseLabel: 'hasBooking',
  },
  {
    aType: 'booking',
    axbType: 'bookedForDeparture',
    bType: 'departure',
    jsonSchema: emptyEdgeSchema,
    description: 'Booking is for a departure',
    inverseLabel: 'hasBooking',
  },
  {
    aType: 'booking',
    axbType: 'includesRider',
    bType: 'rider',
    jsonSchema: primaryContactEdgeSchema,
    description: 'Booking includes a rider',
    inverseLabel: 'riderOn',
  },
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
    lineItems: [{ description: 'Tour spot', quantity: 1, unitPrice: 2500 }],
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
  // Invalid data — JSON Schema catches bad values BEFORE Firestore write
  // ═══════════════════════════════════════════════════════════════
  try {
    await g.putNode('tour', 'bad-tour', {
      name: '', // fails minLength: 1
      difficulty: 'extreme', // fails enum
      maxRiders: -5, // fails exclusiveMinimum: 0
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
  // Strict edge data — extra fields rejected (additionalProperties: false)
  // ═══════════════════════════════════════════════════════════════
  try {
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
