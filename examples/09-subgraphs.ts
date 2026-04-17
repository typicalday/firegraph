/**
 * Subgraphs — scoped graph namespaces in Firestore subcollections
 *
 * Subgraphs let you create isolated graph spaces under a parent node.
 * Each subgraph is a full GraphClient backed by a Firestore subcollection,
 * with optional scope constraints that restrict which types can exist where.
 *
 * Run against the emulator:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8188 npx tsx examples/09-subgraphs.ts
 */
import { Firestore } from '@google-cloud/firestore';

import { createGraphClient, createRegistry, generateId, RegistryScopeError } from '../src/index.js';

const db = new Firestore({ projectId: 'demo-firegraph' });

// ── Schemas ─────────────────────────────────────────────────────

const agentSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};

const memorySchema = {
  type: 'object',
  required: ['text'],
  properties: {
    text: { type: 'string' },
    importance: { type: 'number' },
  },
  additionalProperties: false,
};

const taskSchema = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['pending', 'active', 'done'] },
  },
  additionalProperties: false,
};

const linkSchema = {
  type: 'object',
  properties: { weight: { type: 'number' } },
  additionalProperties: false,
};

async function main() {
  // ═══════════════════════════════════════════════════════════════
  // 1. Basic subgraph — no scope constraints
  // ═══════════════════════════════════════════════════════════════

  const g = createGraphClient(db, 'examples/subgraphs/basic');

  const agentId = generateId();
  await g.putNode('agent', agentId, { name: 'ResearchBot' });
  console.log('Created agent:', agentId);

  // Create a subgraph under the agent
  const memories = g.subgraph(agentId, 'memories');

  const m1 = generateId();
  const m2 = generateId();
  await memories.putNode('memory', m1, { text: 'The sky is blue', importance: 0.3 });
  await memories.putNode('memory', m2, { text: 'Water boils at 100C', importance: 0.8 });
  await memories.putEdge('memory', m1, 'relatedTo', 'memory', m2, { weight: 0.5 });

  console.log('Created 2 memories and 1 edge in subgraph');

  // Subgraph data is isolated from the parent
  const parentMemories = await g.findNodes({ aType: 'memory', allowCollectionScan: true });
  const subMemories = await memories.findNodes({ aType: 'memory', allowCollectionScan: true });
  console.log('Memories in parent:', parentMemories.length); // 0
  console.log('Memories in subgraph:', subMemories.length); // 2
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 2. Default subgraph name
  // ═══════════════════════════════════════════════════════════════

  // When no name is given, defaults to 'graph'
  const defaultSub = g.subgraph(agentId);
  const noteId = generateId();
  await defaultSub.putNode('note', noteId, { text: 'default subgraph' });

  // Same default name = same subgraph
  const defaultSub2 = g.subgraph(agentId);
  const note = await defaultSub2.getNode(noteId);
  console.log('Default subgraph — retrieved note:', note?.data.text);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 3. Nested subgraphs
  // ═══════════════════════════════════════════════════════════════

  const workspace = g.subgraph(agentId, 'workspace');
  const taskId = generateId();
  await workspace.putNode('task', taskId, { title: 'Analyze data', status: 'active' });

  // Nest a subgraph inside another subgraph
  const subtasks = workspace.subgraph(taskId, 'subtasks');
  const st1 = generateId();
  await subtasks.putNode('task', st1, { title: 'Parse CSV', status: 'pending' });

  console.log('Nested subgraph — created subtask:', st1);

  // Each level is isolated
  const workspaceTasks = await workspace.findNodes({ aType: 'task', allowCollectionScan: true });
  const nestedTasks = await subtasks.findNodes({ aType: 'task', allowCollectionScan: true });
  console.log('Tasks in workspace:', workspaceTasks.length); // 1
  console.log('Tasks in subtasks:', nestedTasks.length); // 1
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 4. Scope constraints with allowedIn
  // ═══════════════════════════════════════════════════════════════

  const registry = createRegistry([
    // Agents only at root
    { aType: 'agent', axbType: 'is', bType: 'agent', jsonSchema: agentSchema, allowedIn: ['root'] },
    // Memories only in 'memories' subgraphs (at any depth)
    {
      aType: 'memory',
      axbType: 'is',
      bType: 'memory',
      jsonSchema: memorySchema,
      allowedIn: ['**/memories'],
    },
    // Memory links only in 'memories' subgraphs
    {
      aType: 'memory',
      axbType: 'relatedTo',
      bType: 'memory',
      jsonSchema: linkSchema,
      allowedIn: ['**/memories'],
    },
    // Tasks in workspace subgraphs
    {
      aType: 'task',
      axbType: 'is',
      bType: 'task',
      jsonSchema: taskSchema,
      allowedIn: ['workspace', '**/workspace', '**/subtasks'],
    },
  ]);

  const gs = createGraphClient(db, 'examples/subgraphs/scoped', { registry });

  // Agent at root — OK
  const a1 = generateId();
  await gs.putNode('agent', a1, { name: 'ScopedBot' });
  console.log('Agent at root: OK');

  // Agent in subgraph — blocked
  const scopedMem = gs.subgraph(a1, 'memories');
  try {
    await scopedMem.putNode('agent', generateId(), { name: 'Intruder' });
  } catch (err) {
    if (err instanceof RegistryScopeError) {
      console.log('Agent in memories subgraph: BLOCKED');
      console.log('  ', err.message);
    }
  }

  // Memory at root — blocked
  try {
    await gs.putNode('memory', generateId(), { text: 'root memory' });
  } catch (err) {
    if (err instanceof RegistryScopeError) {
      console.log('Memory at root: BLOCKED');
      console.log('  ', err.message);
    }
  }

  // Memory in memories subgraph — OK
  await scopedMem.putNode('memory', generateId(), { text: 'scoped memory', importance: 1 });
  console.log('Memory in memories subgraph: OK');
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 5. Transactions in subgraphs
  // ═══════════════════════════════════════════════════════════════

  const sub = g.subgraph(agentId, 'memories');
  await sub.runTransaction(async (tx) => {
    const existing = await tx.getNode(m1);
    if (existing) {
      await tx.putNode('memory', m1, {
        text: existing.data.text as string,
        importance: 0.9, // boost importance
      });
    }
  });

  const updated = await sub.getNode(m1);
  console.log('Transaction — updated importance:', updated?.data.importance);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 6. Batches in subgraphs
  // ═══════════════════════════════════════════════════════════════

  const batch = sub.batch();
  const batchIds = [generateId(), generateId(), generateId()];
  for (const [i, id] of batchIds.entries()) {
    await batch.putNode('memory', id, { text: `batch memory ${i + 1}` });
  }
  await batch.commit();

  const allMem = await sub.findNodes({ aType: 'memory', allowCollectionScan: true });
  console.log('After batch — total memories:', allMem.length);
  console.log();

  // ═══════════════════════════════════════════════════════════════
  // 7. Cascade delete cleans up subgraph data
  // ═══════════════════════════════════════════════════════════════

  // Create a fresh agent with subgraph data
  const tempAgent = generateId();
  await g.putNode('agent', tempAgent, { name: 'Temporary' });
  const tempSub = g.subgraph(tempAgent, 'memories');
  await tempSub.putNode('memory', generateId(), { text: 'will be deleted' });
  await tempSub.putNode('memory', generateId(), { text: 'also deleted' });

  // Cascade delete removes the agent AND its subgraph data
  const result = await g.removeNodeCascade(tempAgent);
  console.log('Cascade delete result:');
  console.log('  Node deleted:', result.nodeDeleted);
  console.log('  Total docs deleted:', result.deleted);
  console.log('  Edges deleted:', result.edgesDeleted);

  // Verify subgraph data is gone
  const remaining = await tempSub.findNodes({ aType: 'memory', allowCollectionScan: true });
  console.log('  Remaining memories:', remaining.length); // 0

  // Optionally preserve subgraph data
  const keepAgent = generateId();
  await g.putNode('agent', keepAgent, { name: 'KeepData' });
  const keepSub = g.subgraph(keepAgent, 'memories');
  await keepSub.putNode('memory', generateId(), { text: 'preserved' });

  await g.removeNodeCascade(keepAgent, { deleteSubcollections: false });
  const preserved = await keepSub.findNodes({ aType: 'memory', allowCollectionScan: true });
  console.log('  Preserved memories (deleteSubcollections: false):', preserved.length); // 1

  console.log();
  console.log('Done!');
}

main().catch(console.error);
