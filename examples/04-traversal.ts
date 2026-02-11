/**
 * Graph traversal — multi-hop queries with budget control
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/04-traversal.ts
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { createGraphClient, createRegistry, createTraversal } from '../src/index.js';

initializeApp({ projectId: 'demo-firegraph' });
const db = getFirestore();

// ── Schema + Registry ───────────────────────────────────────────

const tourDataSchema = z.object({ name: z.string().min(1) });
const departureDataSchema = z.object({ date: z.string() });
const riderDataSchema = z.object({ displayName: z.string().min(1) });

const orderedEdgeData = z.object({ order: z.number().int().min(0) });
const riderEdgeData = z.object({ status: z.enum(['pending', 'confirmed', 'cancelled']) });

const registry = createRegistry([
  { aType: 'tour',      abType: 'is', bType: 'tour',      dataSchema: tourDataSchema,      description: 'Tour entity' },
  { aType: 'departure', abType: 'is', bType: 'departure', dataSchema: departureDataSchema, description: 'Departure entity' },
  { aType: 'rider',     abType: 'is', bType: 'rider',     dataSchema: riderDataSchema,     description: 'Rider entity' },
  { aType: 'tour',      abType: 'hasDeparture', bType: 'departure', dataSchema: orderedEdgeData, description: 'Tour has a departure' },
  { aType: 'departure', abType: 'hasRider',     bType: 'rider',     dataSchema: riderEdgeData,   description: 'Departure has a rider' },
]);

const g = createGraphClient(db, 'examples/traverse/graph', { registry });

async function main() {
  // ── Build a graph ─────────────────────────────────────────────
  //
  //   tour1 ──hasDeparture──→ dep1 ──hasRider──→ rider1 (confirmed)
  //     │                       └───hasRider──→ rider4 (confirmed)
  //     ├──hasDeparture──→ dep2 ──hasRider──→ rider2 (pending)
  //     └──hasDeparture──→ dep3 ──hasRider──→ rider3 (confirmed)
  //
  await g.putNode('tour', 'tour1', { name: 'Dolomites Classic' });
  await g.putNode('departure', 'dep1', { date: '2025-07-15' });
  await g.putNode('departure', 'dep2', { date: '2025-08-01' });
  await g.putNode('departure', 'dep3', { date: '2025-09-10' });
  await g.putNode('rider', 'rider1', { displayName: 'Jamie Chen' });
  await g.putNode('rider', 'rider2', { displayName: 'Sam Okafor' });
  await g.putNode('rider', 'rider3', { displayName: 'Priya Patel' });
  await g.putNode('rider', 'rider4', { displayName: 'Luca Moretti' });

  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
  await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', { order: 2 });
  await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider1', { status: 'confirmed' });
  await g.putEdge('departure', 'dep2', 'hasRider', 'rider', 'rider2', { status: 'pending' });
  await g.putEdge('departure', 'dep3', 'hasRider', 'rider', 'rider3', { status: 'confirmed' });
  await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider4', { status: 'confirmed' });

  // ═══════════════════════════════════════════════════════════════
  // 1. Basic two-hop: Tour → Departures → Riders
  // ═══════════════════════════════════════════════════════════════
  const allRiders = await createTraversal(g, 'tour1')
    .follow('hasDeparture')
    .follow('hasRider')
    .run();

  console.log('── All riders for tour1 ──');
  console.log('Riders found:', allRiders.nodes.length);
  console.log('Rider UIDs:', allRiders.nodes.map((e) => e.bUid));
  console.log('Total reads:', allRiders.totalReads);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 2. With in-memory filter: only confirmed riders
  // ═══════════════════════════════════════════════════════════════
  const confirmed = await createTraversal(g, 'tour1')
    .follow('hasDeparture')
    .follow('hasRider', {
      filter: (edge) => edge.data.status === 'confirmed',
    })
    .run();

  console.log('── Confirmed riders only ──');
  console.log('Confirmed:', confirmed.nodes.length);
  console.log('UIDs:', confirmed.nodes.map((e) => e.bUid));
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 3. With per-hop limit
  // ═══════════════════════════════════════════════════════════════
  const limited = await createTraversal(g, 'tour1')
    .follow('hasDeparture', { limit: 2 })
    .follow('hasRider')
    .run();

  console.log('── Limited to 2 departures ──');
  console.log('Departures expanded:', limited.hops[0].edges.length);
  console.log('Riders found:', limited.nodes.length);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 4. Reverse traversal: Rider → Departure → Tour
  // ═══════════════════════════════════════════════════════════════
  const riderTours = await createTraversal(g, 'rider1')
    .follow('hasRider', { direction: 'reverse' })
    .follow('hasDeparture', { direction: 'reverse' })
    .run();

  console.log('── Reverse: which tours does rider1 belong to? ──');
  console.log('Tours:', riderTours.nodes.map((e) => e.aUid));
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 5. Budget enforcement
  // ═══════════════════════════════════════════════════════════════
  const budgeted = await createTraversal(g, 'tour1')
    .follow('hasDeparture')
    .follow('hasRider')
    .run({ maxReads: 2 });

  console.log('── Budget: maxReads=2 ──');
  console.log('Total reads:', budgeted.totalReads);
  console.log('Truncated:', budgeted.truncated);
  console.log('Riders found (partial):', budgeted.nodes.length);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 6. Return intermediates: see what each hop produced
  // ═══════════════════════════════════════════════════════════════
  const detailed = await createTraversal(g, 'tour1')
    .follow('hasDeparture')
    .follow('hasRider')
    .run({ returnIntermediates: true });

  console.log('── With intermediates ──');
  for (const hop of detailed.hops) {
    console.log(
      `  Hop ${hop.depth} (${hop.abType}): ${hop.edges.length} edges from ${hop.sourceCount} sources`,
    );
  }
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 7. Traversal inside a transaction
  // ═══════════════════════════════════════════════════════════════
  const txResult = await g.runTransaction(async (tx) => {
    const result = await createTraversal(tx, 'tour1')
      .follow('hasDeparture')
      .follow('hasRider')
      .run();

    // Could do transactional writes here based on traversal results
    return result;
  });

  console.log('── Inside transaction ──');
  console.log('Riders:', txResult.nodes.length);
  console.log('Reads:', txResult.totalReads);
}

main().catch(console.error);
