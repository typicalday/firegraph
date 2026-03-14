/**
 * Merged registry — static + dynamic coexistence
 *
 * Demonstrates merged mode where a static registry (from filesystem entities
 * or code) provides the core schema, and the dynamic registry extends it at
 * runtime. Static entries take priority and cannot be overridden.
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/11-merged-registry.ts
 */
import { Firestore } from '@google-cloud/firestore';
import {
  createGraphClient,
  createRegistry,
  generateId,
  DynamicRegistryError,
} from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// Static schemas — these represent your core, code-defined types
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
  required: ['date'],
  properties: {
    date: { type: 'string' },
    maxCapacity: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

const edgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
};

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // 1. Define a static registry (your core schema)
  // ═══════════════════════════════════════════════════════════════

  const staticRegistry = createRegistry([
    { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    { aType: 'departure', axbType: 'is', bType: 'departure', jsonSchema: departureSchema },
    { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema, inverseLabel: 'departureOf' },
  ]);

  // ═══════════════════════════════════════════════════════════════
  // 2. Create a merged-mode client (static + dynamic)
  // ═══════════════════════════════════════════════════════════════

  const g = createGraphClient(db, 'examples/merged-registry/graph', {
    registry: staticRegistry,                  // core types (immutable)
    registryMode: { mode: 'dynamic' },         // runtime extensions
  });

  console.log('Created merged-mode client');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 3. Static types work immediately — no reload needed
  // ═══════════════════════════════════════════════════════════════

  const tourId = generateId();
  await g.putNode('tour', tourId, { name: 'Dolomites Classic', difficulty: 'hard' });
  console.log('Created tour (static type, no reload needed):', tourId);

  const depId = generateId();
  await g.putNode('departure', depId, { date: '2025-07-15', maxCapacity: 30 });
  console.log('Created departure (static type):', depId);

  await g.putEdge('tour', tourId, 'hasDeparture', 'departure', depId, { order: 0 });
  console.log('Created edge (static type): tour -> hasDeparture -> departure');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 4. Add new types at runtime via the dynamic registry
  // ═══════════════════════════════════════════════════════════════

  await g.defineNodeType('milestone', {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string', minLength: 1 },
      date: { type: 'string' },
      status: { type: 'string', enum: ['planned', 'reached'] },
    },
    additionalProperties: false,
  }, 'A project milestone');

  await g.defineEdgeType(
    'hasMilestone',
    { from: 'tour', to: 'milestone', inverseLabel: 'milestoneOf' },
    { type: 'object', properties: { priority: { type: 'number' } } },
    'Tours have milestones',
  );

  await g.reloadRegistry();
  console.log('Defined dynamic types: milestone, hasMilestone');
  console.log('Registry reloaded — both static and dynamic types available');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 5. Use both static and dynamic types together
  // ═══════════════════════════════════════════════════════════════

  const milestoneId = generateId();
  await g.putNode('milestone', milestoneId, {
    title: 'Launch v1.0',
    date: '2025-09-01',
    status: 'planned',
  });
  console.log('Created milestone (dynamic type):', milestoneId);

  await g.putEdge('tour', tourId, 'hasMilestone', 'milestone', milestoneId, { priority: 1 });
  console.log('Created edge (dynamic type): tour -> hasMilestone -> milestone');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 6. Override protection — can't redefine static types
  // ═══════════════════════════════════════════════════════════════

  try {
    await g.defineNodeType('tour', { type: 'object' });
  } catch (err) {
    if (err instanceof DynamicRegistryError) {
      console.log('Override blocked — cannot redefine static node type:');
      console.log('  ', err.message);
      console.log();
    }
  }

  try {
    await g.defineEdgeType('hasDeparture', { from: 'tour', to: 'departure' });
  } catch (err) {
    if (err instanceof DynamicRegistryError) {
      console.log('Override blocked — cannot redefine static edge type:');
      console.log('  ', err.message);
      console.log();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 7. Transactions work with the merged registry
  // ═══════════════════════════════════════════════════════════════

  await g.runTransaction(async (tx) => {
    const txTourId = generateId();
    const txMilestoneId = generateId();
    // Mix static and dynamic types in one transaction
    await tx.putNode('tour', txTourId, { name: 'Alps Explorer', difficulty: 'easy' });
    await tx.putNode('milestone', txMilestoneId, { title: 'Route planned', status: 'reached' });
    console.log('Transaction: created tour', txTourId, 'and milestone', txMilestoneId);
  });

  console.log();
  console.log('Done!');
}

main().catch(console.error);
