/**
 * Cross-graph edges — edges that connect nodes across different subgraphs
 *
 * Cross-graph edges let you model relationships between a parent node and
 * nodes in its subgraphs. The key rule: edges live with the target node.
 * Forward traversal uses registry `targetGraph` to know where to look.
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/10-cross-graph-edges.ts
 */
import { Firestore } from '@google-cloud/firestore';

import {
  createGraphClient,
  createRegistry,
  createTraversal,
  generateId,
  isAncestorUid,
  resolveAncestorCollection,
} from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// -- Schemas ------------------------------------------------------------------

const taskSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['pending', 'active', 'done'] },
  },
  additionalProperties: false,
};

const agentSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1 },
    role: { type: 'string' },
  },
  additionalProperties: false,
};

const linkSchema = {
  type: 'object',
  properties: {
    role: { type: 'string' },
    priority: { type: 'number' },
  },
  additionalProperties: false,
};

// -- Registry with targetGraph ------------------------------------------------

// The registry declares that 'assignedTo' edges live in the 'workflow' subgraph.
// This tells forward traversal where to look when starting from a task.
const registry = createRegistry([
  { aType: 'task', axbType: 'is', bType: 'task', jsonSchema: taskSchema },
  { aType: 'agent', axbType: 'is', bType: 'agent', jsonSchema: agentSchema },
  {
    aType: 'task',
    axbType: 'assignedTo',
    bType: 'agent',
    targetGraph: 'workflow',
    jsonSchema: linkSchema,
  },
  { aType: 'agent', axbType: 'mentors', bType: 'agent', jsonSchema: linkSchema },
]);

async function main() {
  const g = createGraphClient(db, 'examples/cross-graph/graph', { registry });

  // =================================================================
  // 1. Set up the graph: tasks at root, agents in workflow subgraphs
  // =================================================================

  const task1 = generateId();
  const task2 = generateId();
  await g.putNode('task', task1, { title: 'Build API', status: 'active' });
  await g.putNode('task', task2, { title: 'Design UI', status: 'pending' });

  console.log('Created tasks in root graph');

  // Each task has a workflow subgraph with agents
  const wf1 = g.subgraph(task1, 'workflow');
  const wf2 = g.subgraph(task2, 'workflow');

  const alice = generateId();
  const bob = generateId();
  const carol = generateId();
  await wf1.putNode('agent', alice, { name: 'Alice', role: 'backend' });
  await wf1.putNode('agent', bob, { name: 'Bob', role: 'devops' });
  await wf2.putNode('agent', carol, { name: 'Carol', role: 'designer' });

  console.log('Created agents in workflow subgraphs');

  // =================================================================
  // 2. Create cross-graph edges in the workflow subgraphs
  // =================================================================

  // The edge documents live alongside the target (agent) in the subgraph.
  // The source (task) is an ancestor node — its UID appears in the path.
  await wf1.putEdge('task', task1, 'assignedTo', 'agent', alice, { role: 'lead', priority: 1 });
  await wf1.putEdge('task', task1, 'assignedTo', 'agent', bob, { role: 'support', priority: 2 });
  await wf2.putEdge('task', task2, 'assignedTo', 'agent', carol, { role: 'lead', priority: 1 });

  // Also create a local edge within the workflow subgraph
  await wf1.putEdge('agent', alice, 'mentors', 'agent', bob, {});

  console.log('Created cross-graph edges');
  console.log();

  // =================================================================
  // 3. Forward traversal: task -> agents (crosses into subgraph)
  // =================================================================

  console.log('-- Forward traversal: task -> agents --');

  const assigned = await createTraversal(g, task1, registry).follow('assignedTo').run();

  console.log(`Task "${task1}" has ${assigned.nodes.length} assigned agents:`);
  for (const edge of assigned.nodes) {
    console.log(`  ${edge.bUid} (role: ${edge.data.role})`);
  }
  console.log(`Total reads: ${assigned.totalReads}`);
  console.log();

  // =================================================================
  // 4. Reverse traversal: agent -> task (local, no cross-graph needed)
  // =================================================================

  console.log('-- Reverse traversal: agent -> task (local) --');

  // From the workflow subgraph's perspective, the edge is local.
  // Reverse traversal finds it without any cross-graph logic.
  const incoming = await wf1.findEdges({
    bUid: alice,
    axbType: 'assignedTo',
    allowCollectionScan: true,
  });

  console.log(`Agent "${alice}" is assigned to:`);
  for (const edge of incoming) {
    console.log(`  task ${edge.aUid} (role: ${edge.data.role})`);
  }
  console.log();

  // =================================================================
  // 5. Explicit targetGraph override on hop
  // =================================================================

  console.log('-- Explicit targetGraph override --');

  // You can override the registry's targetGraph on a per-hop basis.
  // Useful when the same edge type exists in different subgraphs.
  const result = await createTraversal(g, task1)
    .follow('assignedTo', { targetGraph: 'workflow' }) // explicit, no registry needed
    .run();

  console.log(`Explicit hop: found ${result.nodes.length} agents`);
  console.log();

  // =================================================================
  // 6. Path-scanning resolution utilities
  // =================================================================

  console.log('-- Path-scanning resolution --');

  const workflowPath = `examples/cross-graph/graph/${task1}/workflow`;

  // Check if a UID is an ancestor in the path
  console.log(`Is task1 an ancestor? ${isAncestorUid(workflowPath, task1)}`); // true
  console.log(`Is alice an ancestor? ${isAncestorUid(workflowPath, alice)}`); // false

  // Resolve which collection contains an ancestor
  const ancestorCollection = resolveAncestorCollection(workflowPath, task1);
  console.log(`task1 lives in collection: ${ancestorCollection}`);
  // -> 'examples/cross-graph/graph'
  console.log();

  // =================================================================
  // 7. findEdgesGlobal — collection group query across all subgraphs
  // =================================================================

  console.log('-- findEdgesGlobal: cross-cutting query --');

  // Find all 'assignedTo' edges across ALL workflow subgraphs.
  // Uses Firestore collection group queries under the hood.
  const allAssignments = await g.findEdgesGlobal(
    { axbType: 'assignedTo', allowCollectionScan: true },
    'workflow',
  );

  console.log(`Total assignments across all workflows: ${allAssignments.length}`);
  for (const edge of allAssignments) {
    console.log(`  ${edge.aUid} -> ${edge.bUid} (role: ${edge.data.role})`);
  }
  console.log();

  // =================================================================
  // 8. Cascade delete removes subgraph data including cross-graph edges
  // =================================================================

  console.log('-- Cascade delete --');

  const deleteResult = await g.removeNodeCascade(task2);
  console.log(
    `Deleted task2: nodeDeleted=${deleteResult.nodeDeleted}, total=${deleteResult.deleted}`,
  );

  // Verify the workflow subgraph is gone
  const remainingAgents = await wf2.findNodes({ aType: 'agent', allowCollectionScan: true });
  console.log(`Agents remaining in task2 workflow: ${remainingAgents.length}`); // 0

  const remainingEdges = await wf2.findEdges({ axbType: 'assignedTo', allowCollectionScan: true });
  console.log(`Edges remaining in task2 workflow: ${remainingEdges.length}`); // 0

  console.log();
  console.log('Done!');
}

main().catch(console.error);
