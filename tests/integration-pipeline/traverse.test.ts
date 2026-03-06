/**
 * Pipeline Integration — Traversal Tests
 *
 * Validates that multi-hop traversal works correctly when the underlying
 * client uses pipeline mode for queries. Mirrors tests/integration/traverse.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPipelineClient,
  uniqueCollectionPath,
  cleanupCollection,
} from './setup.js';
import { createTraversal } from '../../src/traverse.js';
import type { GraphClient } from '../../src/types.js';

describe('pipeline traversal', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  // Graph fixture (mirrors tests/integration/traverse.test.ts):
  // tour1 --hasDeparture--> dep1 --hasRider--> rider1 (confirmed)
  // tour1 --hasDeparture--> dep2 --hasRider--> rider2 (pending)
  // tour1 --hasDeparture--> dep3 --hasRider--> rider3 (confirmed)
  //                         dep1 --hasRider--> rider4 (confirmed)
  beforeAll(async () => {
    g = createPipelineClient(collPath);

    await g.putNode('tour', 'tour1', { name: 'Dolomites Classic' });
    await g.putNode('departure', 'dep1', { date: '2025-07-15' });
    await g.putNode('departure', 'dep2', { date: '2025-08-01' });
    await g.putNode('departure', 'dep3', { date: '2025-09-01' });
    await g.putNode('rider', 'rider1', { name: 'Alex' });
    await g.putNode('rider', 'rider2', { name: 'Maria' });
    await g.putNode('rider', 'rider3', { name: 'Chen' });
    await g.putNode('rider', 'rider4', { name: 'Luca' });

    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep1', { order: 0 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep2', { order: 1 });
    await g.putEdge('tour', 'tour1', 'hasDeparture', 'departure', 'dep3', { order: 2 });
    await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider1', { status: 'confirmed' });
    await g.putEdge('departure', 'dep2', 'hasRider', 'rider', 'rider2', { status: 'pending' });
    await g.putEdge('departure', 'dep3', 'hasRider', 'rider', 'rider3', { status: 'confirmed' });
    await g.putEdge('departure', 'dep1', 'hasRider', 'rider', 'rider4', { status: 'confirmed' });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  describe('single hop', () => {
    it('Tour → departures returns correct edges', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes.every((e) => e.axbType === 'hasDeparture')).toBe(true);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('two hops', () => {
    it('Tour → departures → riders returns riders', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run();

      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
      expect(result.nodes.every((e) => e.axbType === 'hasRider')).toBe(true);
      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].axbType).toBe('hasDeparture');
      expect(result.hops[1].axbType).toBe('hasRider');
    });
  });

  describe('reverse traversal', () => {
    it('Rider → (reverse hasRider) → departures', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aUid).toBe('dep1');
      expect(result.nodes[0].bUid).toBe('rider1');
    });

    it('two-hop reverse: Rider → departures → tours', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse' })
        .follow('hasDeparture', { direction: 'reverse' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aUid).toBe('tour1');
    });
  });

  describe('per-hop limit', () => {
    it('limit=2 on first hop returns max 2 departures', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { limit: 2 })
        .run();

      expect(result.nodes).toHaveLength(2);
    });
  });

  describe('in-memory filter', () => {
    it('filter callback excludes certain edges', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider', {
          filter: (e) => e.data.status === 'confirmed',
        })
        .run();

      expect(result.nodes.every((e) => e.data.status === 'confirmed')).toBe(true);
      expect(result.nodes.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('budget enforcement', () => {
    it('maxReads=2 with fan-out sets truncated=true', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ maxReads: 2 });

      expect(result.totalReads).toBeLessThanOrEqual(2);
      expect(result.truncated).toBe(true);
    });
  });

  describe('return intermediates', () => {
    it('result.hops has per-hop edge arrays', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ returnIntermediates: true });

      expect(result.hops).toHaveLength(2);
      expect(result.hops[0].edges.length).toBeGreaterThan(0);
      expect(result.hops[0].edges.every((e) => e.axbType === 'hasDeparture')).toBe(true);
      expect(result.hops[1].edges.length).toBeGreaterThan(0);
      expect(result.hops[1].edges.every((e) => e.axbType === 'hasRider')).toBe(true);
    });
  });

  describe('empty results', () => {
    it('traversal from nonexistent node returns empty', async () => {
      const result = await createTraversal(g, 'nonexistent-uid')
        .follow('hasDeparture')
        .run();

      expect(result.nodes).toHaveLength(0);
      expect(result.totalReads).toBe(1);
      expect(result.truncated).toBe(false);
    });
  });

  describe('transaction support', () => {
    it('traversal works inside runTransaction (uses standard queries)', async () => {
      const result = await g.runTransaction(async (tx) => {
        return createTraversal(tx, 'tour1')
          .follow('hasDeparture')
          .follow('hasRider')
          .run();
      });

      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
      expect(result.hops).toHaveLength(2);
    });
  });

  describe('findEdges limit/orderBy via pipeline', () => {
    it('findEdges with limit works', async () => {
      const edges = await g.findEdges({ aUid: 'tour1', axbType: 'hasDeparture', limit: 1 });
      expect(edges).toHaveLength(1);
      expect(edges[0].axbType).toBe('hasDeparture');
    });

    it('findEdges with orderBy + limit works', async () => {
      const edges = await g.findEdges({
        aUid: 'tour1',
        axbType: 'hasDeparture',
        orderBy: { field: 'data.order', direction: 'desc' },
        limit: 2,
      });
      expect(edges).toHaveLength(2);
      expect(edges[0].data.order).toBe(2);
      expect(edges[1].data.order).toBe(1);
    });
  });

  describe('orderBy on traversal hops', () => {
    it('orderBy sorts edges within a single hop', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { orderBy: { field: 'data.order', direction: 'desc' } })
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes[0].data.order).toBe(2);
      expect(result.nodes[1].data.order).toBe(1);
      expect(result.nodes[2].data.order).toBe(0);
    });

    it('orderBy asc on hop with limit returns lowest-order edges', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', {
          orderBy: { field: 'data.order', direction: 'asc' },
          limit: 2,
        })
        .run();

      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].data.order).toBe(0);
      expect(result.nodes[1].data.order).toBe(1);
    });
  });

  describe('bType filter on forward hops', () => {
    it('bType narrows target node type on forward hop', async () => {
      // hasDeparture edges have bType=departure — filtering by bType='departure' should match all
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { bType: 'departure' })
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes.every((e) => e.bType === 'departure')).toBe(true);
    });

    it('bType with non-matching type returns empty', async () => {
      // No hasDeparture edges have bType='rider'
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { bType: 'rider' })
        .run();

      expect(result.nodes).toHaveLength(0);
    });
  });

  describe('aType filter on forward hops', () => {
    it('aType narrows source node type on forward hop', async () => {
      // Forward from tour1: aUid=tour1, and our edges have aType=tour
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { aType: 'tour' })
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes.every((e) => e.aType === 'tour')).toBe(true);
    });

    it('aType with non-matching type returns empty', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture', { aType: 'rider' })
        .run();

      expect(result.nodes).toHaveLength(0);
    });
  });

  describe('aType filter on reverse hops', () => {
    it('aType narrows source type on reverse traversal', async () => {
      // Reverse from rider1: looking for hasRider where bUid=rider1 and aType=departure
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse', aType: 'departure' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].aType).toBe('departure');
      expect(result.nodes[0].aUid).toBe('dep1');
    });

    it('aType with non-matching type on reverse returns empty', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse', aType: 'tour' })
        .run();

      expect(result.nodes).toHaveLength(0);
    });
  });

  describe('bType filter on reverse hops', () => {
    it('bType narrows target type on reverse traversal', async () => {
      // Reverse from rider1: hasRider where bUid=rider1, bType should be 'rider'
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse', bType: 'rider' })
        .run();

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].bType).toBe('rider');
    });

    it('bType with non-matching type on reverse returns empty', async () => {
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse', bType: 'departure' })
        .run();

      expect(result.nodes).toHaveLength(0);
    });
  });

  describe('concurrency control', () => {
    it('concurrency=1 serializes fan-out and produces same results', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ concurrency: 1 });

      // Same results as default concurrency: 4 riders total
      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
      expect(result.nodes.every((e) => e.axbType === 'hasRider')).toBe(true);
      // Hop 2 fans out over 3 departure UIDs — all serialized
      expect(result.hops[1].sourceCount).toBe(3);
    });

    it('high concurrency does not break results', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ concurrency: 50 });

      expect(result.nodes.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('mixed forward + reverse chain', () => {
    it('forward → reverse → forward traversal works', async () => {
      // tour1 → dep1 (forward hasDeparture)
      // dep1 → rider1 (forward hasRider)
      // Now reverse from rider1 back up to departures to find all departures the rider is booked on
      // Then forward again to find co-riders

      // Simpler: forward from tour1 to deps, then reverse from dep1 to get tour1 back
      const result = await createTraversal(g, 'rider1')
        .follow('hasRider', { direction: 'reverse' })  // rider1 → dep1
        .follow('hasDeparture', { direction: 'reverse' })  // dep1 → tour1
        .follow('hasDeparture')  // tour1 → dep1, dep2, dep3
        .run();

      expect(result.nodes).toHaveLength(3);
      expect(result.nodes.every((e) => e.axbType === 'hasDeparture')).toBe(true);
      expect(result.hops).toHaveLength(3);
    });
  });

  describe('three-hop traversal', () => {
    it('tour → departures → riders via 3 hops (with intermediate reverse)', async () => {
      // Three-hop forward chain isn't possible with current fixture (only 2 edge types)
      // So test: tour1 → deps (forward) → riders (forward) → back to deps (reverse hasRider)
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')  // → dep1, dep2, dep3
        .follow('hasRider')      // → rider1, rider2, rider3, rider4
        .follow('hasRider', { direction: 'reverse' })  // → back to deps that have these riders
        .run();

      expect(result.hops).toHaveLength(3);
      // Last hop should find the departure nodes the riders are on
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes.every((e) => e.axbType === 'hasRider')).toBe(true);
    });
  });

  describe('filter + limit interaction on hops', () => {
    it('filter applies before limit, returning filtered subset', async () => {
      // dep1 has 2 riders: rider1 (confirmed), rider4 (confirmed)
      // dep2 has 1 rider: rider2 (pending)
      // dep3 has 1 rider: rider3 (confirmed)
      // With filter=confirmed, total = 3 riders across 3 deps
      // With limit=1 per source, each dep returns at most 1 confirmed rider
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider', {
          filter: (e) => e.data.status === 'confirmed',
          limit: 1,
        })
        .run();

      expect(result.nodes.every((e) => e.data.status === 'confirmed')).toBe(true);
      // dep1 has 2 confirmed but limit=1 → 1; dep2 has 0 confirmed → 0; dep3 has 1 → 1
      // Total: 2
      expect(result.nodes).toHaveLength(2);
    });
  });

  describe('hop metadata accuracy', () => {
    it('each hop reports correct sourceCount', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ returnIntermediates: true });

      expect(result.hops[0].sourceCount).toBe(1); // 1 tour
      expect(result.hops[1].sourceCount).toBe(3); // 3 departures
    });

    it('hop depth values are sequential', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run();

      expect(result.hops[0].depth).toBe(0);
      expect(result.hops[1].depth).toBe(1);
    });

    it('truncated is false when all reads complete within budget', async () => {
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ maxReads: 100 });

      expect(result.truncated).toBe(false);
      expect(result.totalReads).toBe(4); // 1 (tour→deps) + 3 (dep1→riders, dep2→riders, dep3→riders)
    });
  });

  describe('deduplication of source UIDs between hops', () => {
    it('duplicate bUids in hop 1 are deduplicated for hop 2 sources', async () => {
      // If two edges in hop 1 pointed to the same bUid, hop 2 should only query once
      // In our fixture, all bUids are unique, but we can verify sourceCount behavior
      const result = await createTraversal(g, 'tour1')
        .follow('hasDeparture')
        .follow('hasRider')
        .run({ returnIntermediates: true });

      // All 3 departures are unique, so hop 2 sourceCount = 3
      expect(result.hops[1].sourceCount).toBe(3);
      // totalReads = 1 (hop1) + 3 (hop2) = 4
      expect(result.totalReads).toBe(4);
    });
  });
});

/**
 * Extended traversal tests with a richer graph fixture.
 *
 * Graph:
 *   org1 --hasDept--> dept1 --hasTeam--> team1 --hasMember--> member1
 *   org1 --hasDept--> dept1 --hasTeam--> team2 --hasMember--> member2
 *   org1 --hasDept--> dept2 --hasTeam--> team1 --hasMember--> member1  (team1 reachable from 2 depts)
 *   org1 --hasDept--> dept2 --hasTeam--> team3 --hasMember--> member3
 *
 * This enables:
 * - Three-hop forward traversal (org → dept → team → member)
 * - Deduplication testing (team1 reachable via dept1 AND dept2)
 * - Wide fan-out with concurrency
 */
describe('pipeline traversal (extended fixture)', () => {
  const collPath = uniqueCollectionPath();
  let g: GraphClient;

  beforeAll(async () => {
    g = createPipelineClient(collPath);

    await g.putNode('org', 'org1', { name: 'Acme Corp' });
    await g.putNode('dept', 'dept1', { name: 'Engineering', headcount: 50 });
    await g.putNode('dept', 'dept2', { name: 'Design', headcount: 20 });
    await g.putNode('team', 'team1', { name: 'Backend', size: 8 });
    await g.putNode('team', 'team2', { name: 'Frontend', size: 6 });
    await g.putNode('team', 'team3', { name: 'UX', size: 4 });
    await g.putNode('member', 'member1', { name: 'Alice', role: 'lead' });
    await g.putNode('member', 'member2', { name: 'Bob', role: 'senior' });
    await g.putNode('member', 'member3', { name: 'Carol', role: 'junior' });

    await g.putEdge('org', 'org1', 'hasDept', 'dept', 'dept1', { priority: 1 });
    await g.putEdge('org', 'org1', 'hasDept', 'dept', 'dept2', { priority: 2 });
    await g.putEdge('dept', 'dept1', 'hasTeam', 'team', 'team1', { floor: 3 });
    await g.putEdge('dept', 'dept1', 'hasTeam', 'team', 'team2', { floor: 3 });
    await g.putEdge('dept', 'dept2', 'hasTeam', 'team', 'team1', { floor: 5 }); // team1 shared
    await g.putEdge('dept', 'dept2', 'hasTeam', 'team', 'team3', { floor: 5 });
    await g.putEdge('team', 'team1', 'hasMember', 'member', 'member1', { since: '2023-01' });
    await g.putEdge('team', 'team2', 'hasMember', 'member', 'member2', { since: '2024-03' });
    await g.putEdge('team', 'team3', 'hasMember', 'member', 'member3', { since: '2024-06' });
  }, 30_000);

  afterAll(async () => {
    await cleanupCollection(collPath);
  }, 15_000);

  it('three-hop forward: org → depts → teams → members', async () => {
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam')
      .follow('hasMember')
      .run();

    expect(result.hops).toHaveLength(3);
    expect(result.hops[0].axbType).toBe('hasDept');
    expect(result.hops[1].axbType).toBe('hasTeam');
    expect(result.hops[2].axbType).toBe('hasMember');
    // All 3 members reachable (traversal returns edge records, not node records)
    expect(result.nodes).toHaveLength(3);
    const memberUids = result.nodes.map((e) => e.bUid).sort();
    expect(memberUids).toEqual(['member1', 'member2', 'member3']);
    // Edge data has 'since', not member name
    expect(result.nodes.every((e) => typeof e.data.since === 'string')).toBe(true);
  });

  it('deduplicates shared nodes between hops', async () => {
    // team1 is reachable from both dept1 and dept2
    // Hop 2 should find 4 edges (2 from dept1 + 2 from dept2)
    // But the unique bUids are team1, team2, team3 — 3 unique teams
    // Hop 3 should fan out over 3 unique teams, not 4

    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam')
      .follow('hasMember')
      .run({ returnIntermediates: true });

    // Hop 1: 1 org → 2 depts
    expect(result.hops[0].sourceCount).toBe(1);
    expect(result.hops[0].edges).toHaveLength(2);

    // Hop 2: 2 depts → 4 edges but 3 unique teams
    expect(result.hops[1].sourceCount).toBe(2);
    expect(result.hops[1].edges).toHaveLength(4); // dept1→team1, dept1→team2, dept2→team1, dept2→team3

    // Hop 3: 3 unique teams (deduplicated) → 3 members
    expect(result.hops[2].sourceCount).toBe(3); // team1, team2, team3
    expect(result.hops[2].edges).toHaveLength(3);
  });

  it('three-hop with limit on middle hop constrains downstream', async () => {
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam', { limit: 1 }) // each dept gets max 1 team
      .follow('hasMember')
      .run({ returnIntermediates: true });

    expect(result.hops).toHaveLength(3);
    // Each of 2 depts returns at most 1 team
    expect(result.hops[1].edges.length).toBeLessThanOrEqual(2);
    // Members reachable is limited by the constrained teams
    expect(result.nodes.length).toBeLessThanOrEqual(2);
  });

  it('three-hop fully reverse: member → team → dept → org', async () => {
    const result = await createTraversal(g, 'member1')
      .follow('hasMember', { direction: 'reverse' }) // → team1
      .follow('hasTeam', { direction: 'reverse' })    // → dept1, dept2
      .follow('hasDept', { direction: 'reverse' })     // → org1
      .run({ returnIntermediates: true });

    expect(result.hops).toHaveLength(3);
    // member1 → team1
    expect(result.hops[0].edges).toHaveLength(1);
    // team1 → dept1, dept2 (team1 is shared between both depts)
    expect(result.hops[1].edges).toHaveLength(2);
    // Both depts find hasDept edges pointing to org1 — 2 edge records (one per dept)
    // Traversal returns edge records, not unique nodes, so 2 edges both with aUid=org1
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every((e) => e.aUid === 'org1')).toBe(true);
    // Source UIDs for this hop were dept1 and dept2 (deduplicated from hop 2)
    expect(result.hops[2].sourceCount).toBe(2);
  });

  it('orderBy on middle hop affects downstream traversal', async () => {
    // Order teams by floor asc within each dept, limit to 1
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam', { orderBy: { field: 'data.floor', direction: 'asc' }, limit: 1 })
      .follow('hasMember')
      .run({ returnIntermediates: true });

    expect(result.hops).toHaveLength(3);
    // Each dept gets 1 team (the one with lowest floor)
    expect(result.hops[1].edges.length).toBeLessThanOrEqual(2);
    // Members are those on the selected teams
    expect(result.nodes.length).toBeLessThanOrEqual(2);
  });

  it('budget truncation across three hops', async () => {
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam')
      .follow('hasMember')
      .run({ maxReads: 2 });

    // Only 2 reads allowed: hop1 (1 read) + hop2 (1 of 2 dept reads)
    expect(result.totalReads).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it('concurrency=1 produces correct results for three-hop', async () => {
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam')
      .follow('hasMember')
      .run({ concurrency: 1 });

    // Same 3 members regardless of serialization
    expect(result.nodes).toHaveLength(3);
    const memberUids = result.nodes.map((e) => e.bUid).sort();
    expect(memberUids).toEqual(['member1', 'member2', 'member3']);
  });

  it('returnIntermediates preserves all hop edge arrays', async () => {
    const result = await createTraversal(g, 'org1')
      .follow('hasDept')
      .follow('hasTeam')
      .follow('hasMember')
      .run({ returnIntermediates: true });

    // Every hop has edges populated
    for (const hop of result.hops) {
      expect(hop.edges.length).toBeGreaterThan(0);
    }

    // Final nodes are last hop's edges
    expect(result.nodes).toEqual(result.hops[2].edges);
  });
});
