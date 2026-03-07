/**
 * Dynamic registry — agent-driven schema definition at runtime
 *
 * The dynamic registry lets agents define new node and edge types as graph
 * data itself. Type definitions are stored as meta-nodes in the graph and
 * compiled into a live registry on demand.
 *
 * Workflow: define → reload → write
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/08-dynamic-registry.ts
 */
import { Firestore } from '@google-cloud/firestore';
import {
  createGraphClient,
  generateId,
  ValidationError,
  RegistryViolationError,
  DynamicRegistryError,
} from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // 1. Create a dynamic-mode client
  // ═══════════════════════════════════════════════════════════════

  const g = createGraphClient(db, 'examples/dynamic-registry/graph', {
    registryMode: { mode: 'dynamic' },
  });

  console.log('Created dynamic-mode client');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 2. Define node types — stored as meta-nodes in the graph
  // ═══════════════════════════════════════════════════════════════

  await g.defineNodeType('tour', {
    type: 'object',
    required: ['name', 'difficulty'],
    properties: {
      name: { type: 'string', minLength: 1 },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    },
    additionalProperties: false,
  }, 'A guided cycling tour');

  await g.defineNodeType('departure', {
    type: 'object',
    required: ['date', 'maxCapacity'],
    properties: {
      date: { type: 'string' },
      maxCapacity: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  }, 'A scheduled departure date');

  console.log('Defined node types: tour, departure');

  // ═══════════════════════════════════════════════════════════════
  // 3. Define edge types — topology + optional data schema
  // ═══════════════════════════════════════════════════════════════

  await g.defineEdgeType(
    'hasDeparture',
    { from: 'tour', to: 'departure', inverseLabel: 'departureOf' },
    {
      type: 'object',
      required: ['order'],
      properties: { order: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    'Tours have scheduled departures',
  );

  console.log('Defined edge type: hasDeparture');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 4. Domain writes BEFORE reload are rejected
  // ═══════════════════════════════════════════════════════════════

  try {
    await g.putNode('tour', generateId(), { name: 'Alps', difficulty: 'hard' });
  } catch (err) {
    if (err instanceof RegistryViolationError) {
      console.log('Before reload — domain write rejected:');
      console.log('  ', err.message);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. Compile the registry from stored definitions
  // ═══════════════════════════════════════════════════════════════

  await g.reloadRegistry();
  console.log('Registry compiled from graph');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 6. Write domain data — validated against compiled schemas
  // ═══════════════════════════════════════════════════════════════

  const tourId = generateId();
  await g.putNode('tour', tourId, { name: 'Dolomites Classic', difficulty: 'hard' });
  console.log('Created tour:', tourId);

  const depId = generateId();
  await g.putNode('departure', depId, { date: '2025-07-15', maxCapacity: 30 });
  console.log('Created departure:', depId);

  await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 0 });
  console.log('Created edge: tour → hasDeparture → departure');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 7. Validation in action — bad data is rejected
  // ═══════════════════════════════════════════════════════════════

  try {
    await g.putNode('tour', generateId(), {
      name: '',              // fails minLength: 1
      difficulty: 'extreme', // fails enum
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('ValidationError — bad tour data:');
      console.log('  ', err.message);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 8. Unknown types are always rejected
  // ═══════════════════════════════════════════════════════════════

  try {
    await g.putNode('booking', generateId(), { total: 500 });
  } catch (err) {
    if (err instanceof RegistryViolationError) {
      console.log('RegistryViolationError — unknown type:');
      console.log('  ', err.message);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 9. Upsert — redefining a type updates its schema
  // ═══════════════════════════════════════════════════════════════

  await g.defineNodeType('tour', {
    type: 'object',
    required: ['name', 'difficulty', 'region'],
    properties: {
      name: { type: 'string', minLength: 1 },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
      region: { type: 'string' },
    },
    additionalProperties: false,
  });
  await g.reloadRegistry();
  console.log('Redefined tour type — now requires "region"');

  try {
    await g.putNode('tour', generateId(), { name: 'Alps', difficulty: 'easy' });
  } catch (err) {
    if (err instanceof ValidationError) {
      console.log('ValidationError — missing required "region":');
      console.log('  ', err.message);
      console.log();
    }
  }

  // With the new required field it works:
  const updatedTourId = generateId();
  await g.putNode('tour', updatedTourId, {
    name: 'Alps Explorer',
    difficulty: 'easy',
    region: 'Western Alps',
  });
  console.log('Created tour with updated schema:', updatedTourId);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 10. Reserved names — can't shadow meta-types
  // ═══════════════════════════════════════════════════════════════

  try {
    await g.defineNodeType('nodeType', { type: 'object' });
  } catch (err) {
    if (err instanceof DynamicRegistryError) {
      console.log('DynamicRegistryError — reserved name:');
      console.log('  ', err.message);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 11. Transactions work with the dynamic registry
  // ═══════════════════════════════════════════════════════════════

  await g.runTransaction(async (tx) => {
    const txTourId = generateId();
    await tx.putNode('tour', txTourId, {
      name: 'Transaction Tour',
      difficulty: 'medium',
      region: 'Dolomites',
    });
    console.log('Transaction: created tour', txTourId);
  });

  // ═══════════════════════════════════════════════════════════════
  // 12. Separate meta-collection (optional)
  // ═══════════════════════════════════════════════════════════════

  const gSeparate = createGraphClient(db, 'examples/dynamic-registry/domain', {
    registryMode: { mode: 'dynamic', collection: 'examples/dynamic-registry/meta' },
  });

  await gSeparate.defineNodeType('project', {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  });
  await gSeparate.reloadRegistry();

  const projId = generateId();
  await gSeparate.putNode('project', projId, { name: 'Firegraph' });
  console.log('Separate collection: created project', projId);

  // Meta-nodes are NOT in the domain collection
  const metaInDomain = await gSeparate.findNodes({ aType: 'nodeType' });
  console.log('Meta-nodes in domain collection:', metaInDomain.length); // 0

  console.log();
  console.log('Done!');
}

main().catch(console.error);
