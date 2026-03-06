# Firegraph Integration Guide

Firegraph is a typed graph data layer for Firebase Cloud Firestore. It stores nodes and edges as triples in a single collection with smart query planning, sharded document IDs, JSON Schema validation, and multi-hop traversal.

## Installation

Install from the GitHub repository:

```bash
# npm
npm install git+ssh://git@github.com:typicalday/firegraph.git firebase-admin

# pnpm
pnpm add git+ssh://git@github.com:typicalday/firegraph.git firebase-admin
```

**Build dependencies:** firegraph ships as source when installed from git. A `prepare` script runs `tsup` automatically after install to build the package. The consuming project must have `tsup` and `typescript` available — install them as dev dependencies:

```bash
npm install -D tsup typescript
```

**pnpm users:** pnpm 10+ blocks dependency build scripts by default. You must allow `firegraph` and its dependency `esbuild` to run build scripts. Add this to the consuming project's `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "firegraph"]
  }
}
```

Without this, the `prepare` script is silently skipped and the `dist/` directory won't exist.

For framework adapters (optional):
- React projects also need: `react` and `react-dom` (^18 or ^19)
- Svelte projects also need: `svelte` (^5) and `esbuild-svelte`

Requires Node.js 18+.

## Project Setup

### 1. Initialize Firebase Admin

```typescript
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// For production (uses Application Default Credentials)
initializeApp({ credential: applicationDefault(), projectId: 'my-project' });

// For local development with emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
initializeApp({ projectId: 'my-local-project' });

const db = getFirestore();
```

### 2. Create a Graph Client

```typescript
import { createGraphClient } from 'firegraph';

// Basic (no validation)
const g = createGraphClient(db, 'my-collection');

// With registry validation (recommended)
const g = createGraphClient(db, 'my-collection', { registry });
```

All graph data lives in a single Firestore collection specified by the second argument.

### 3. Create a Configuration File

Create `firegraph.config.ts` in your project root:

```typescript
import { defineConfig } from 'firegraph';

export default defineConfig({
  entities: './entities',           // path to entities directory
  project: 'my-project',           // Firebase project ID
  collection: 'my-collection',     // Firestore collection name
  emulator: '127.0.0.1:8080',      // emulator host:port (omit for production)

  editor: {
    port: 3883,                     // editor server port
    readonly: false,                // set true for read-only mode
  },

  // chat: { model: 'haiku' },     // optional AI chat config (auto-detected)
});
```

## Per-Entity Folder Convention

Organize your graph schema in a convention-based directory:

```
entities/
  nodes/
    task/
      schema.json        # JSON Schema for data payload (required)
      meta.json          # description, viewDefaults (optional)
      sample.json        # sample data for editor gallery (optional)
      views.ts           # Web Component view classes (optional)
    user/
      schema.json
  edges/
    hasTask/
      schema.json        # JSON Schema for edge data (required)
      edge.json          # topology: from/to + inverseLabel (required)
      views.ts           # (optional)
```

### Node schema.json

Standard JSON Schema describing the `data` payload:

```json
{
  "type": "object",
  "required": ["title", "status"],
  "properties": {
    "title": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "enum": ["created", "active", "completed"] }
  },
  "additionalProperties": false
}
```

### Edge edge.json

Topology declaration. `from`/`to` accept string or string[] for edges connecting multiple node types:

```json
{ "from": "task", "to": "step", "inverseLabel": "stepOf" }
```

### Edge schema.json

JSON Schema for edge data payload:

```json
{
  "type": "object",
  "required": ["order"],
  "properties": {
    "order": { "type": "integer", "minimum": 0 }
  }
}
```

### meta.json (optional)

```json
{
  "description": "A unit of work",
  "viewDefaults": { "default": "card", "detail": "detail" }
}
```

## Registry & Validation

### Auto-discovery from entities directory (recommended)

```typescript
import { createRegistry, discoverEntities } from 'firegraph';

const entitiesDir = './entities';
const { result, warnings } = discoverEntities(entitiesDir);
for (const w of warnings) console.warn(w.message);

const registry = createRegistry(result);
const g = createGraphClient(db, 'my-collection', { registry });
```

### Manual registry definition

```typescript
import { createRegistry } from 'firegraph';

const registry = createRegistry([
  {
    aType: 'task',
    axbType: 'is',        // 'is' = node self-loop
    bType: 'task',
    jsonSchema: taskSchema,
  },
  {
    aType: 'task',
    axbType: 'hasStep',
    bType: 'step',
    jsonSchema: stepEdgeSchema,
    inverseLabel: 'stepOf',
  },
]);
```

The registry validates:
- **Triple validation** — (aType, axbType, bType) must be registered
- **Data validation** — payload validates against JSON Schema via ajv
- Unregistered triples throw `RegistryViolationError`
- Invalid data throws `ValidationError`

## Core API

### Graph Model

Every record is a triple: `(aType, aUid) -[axbType]-> (bType, bUid)`.

- **Nodes** are self-loops with relation `is`: `(task, Kj7vNq2mP9xR4wL1tY8s3) -[is]-> (task, Kj7vNq2mP9xR4wL1tY8s3)`
- **Edges** are directed: `(task, Kj7vNq2mP9xR4wL1tY8s3) -[hasStep]-> (step, Xp4nTk8qW2vR7mL9jY5a1)`

UIDs must be generated via `generateId()` (21-char nanoid). Short sequential strings like `task1` create Firestore write hotspots.

### ID Generation

```typescript
import { generateId } from 'firegraph';
const id = generateId(); // 21-char URL-safe nanoid
```

### Node CRUD

```typescript
// Create
const taskId = generateId();
await g.putNode('task', taskId, { title: 'Build feature', status: 'created' });

// Read
const task = await g.getNode(taskId); // StoredGraphRecord | null

// Update (merge)
await g.updateNode(taskId, { 'data.status': 'active' });

// Delete
await g.removeNode(taskId);

// Find all nodes of a type
const tasks = await g.findNodes({ aType: 'task' });
```

### Edge CRUD

```typescript
// Create
await g.putEdge('task', taskId, 'hasStep', 'step', stepId, { order: 0 });

// Read
const edge = await g.getEdge(taskId, 'hasStep', stepId);

// Check existence
const exists = await g.edgeExists(taskId, 'hasStep', stepId);

// Delete
await g.removeEdge(taskId, 'hasStep', stepId);
```

### Querying Edges

```typescript
// Forward: all steps of a task
await g.findEdges({ aUid: taskId, axbType: 'hasStep' });

// Reverse: which task owns this step
await g.findEdges({ axbType: 'hasStep', bUid: stepId });

// Type-scoped
await g.findEdges({ aType: 'task', axbType: 'hasStep' });

// With ordering and limit
await g.findEdges({
  aUid: taskId,
  axbType: 'hasStep',
  limit: 10,
  orderBy: { field: 'data.order', direction: 'asc' },
});
```

When all three identifiers (aUid, axbType, bUid) are provided, firegraph uses a direct document lookup instead of a query scan.

### Transactions

```typescript
const result = await g.runTransaction(async (tx) => {
  const step = await tx.getNode(stepId);
  if (step?.data.status !== 'created') return { claimed: false };

  await tx.updateNode(stepId, { 'data.status': 'claimed' });
  await tx.putEdge('instance', instanceId, 'claimed', 'step', stepId, {
    claimedAt: new Date().toISOString(),
  });
  return { claimed: true };
});
```

The transaction object has the same read/write methods as the client. Writes are atomic with automatic retry on conflicts.

### Batch Writes

```typescript
const batch = g.batch();
await batch.putNode('step', step1Id, { title: 'Step 1', order: 0 });
await batch.putNode('step', step2Id, { title: 'Step 2', order: 1 });
await batch.putEdge('task', taskId, 'hasStep', 'step', step1Id, { order: 0 });
await batch.putEdge('task', taskId, 'hasStep', 'step', step2Id, { order: 1 });
await batch.commit(); // atomic — nothing written until commit
```

### Graph Traversal

```typescript
import { createTraversal } from 'firegraph';

// Two-hop: task -> steps -> assigned agents
const result = await createTraversal(g, taskId)
  .follow('hasStep', { orderBy: { field: 'data.order', direction: 'asc' } })
  .follow('assignedTo')
  .run({ maxReads: 100, returnIntermediates: true });

result.nodes;      // edges from final hop
result.hops;       // per-hop breakdown
result.totalReads; // Firestore reads consumed
result.truncated;  // true if budget exceeded
```

Reverse traversal:

```typescript
const parentTask = await createTraversal(g, stepId)
  .follow('hasStep', { direction: 'reverse' })
  .run();
```

Traversal works inside transactions too:

```typescript
await g.runTransaction(async (tx) => {
  const result = await createTraversal(tx, taskId)
    .follow('hasStep')
    .run();
  // make writes based on traversal results
});
```

## Error Handling

All errors extend `FiregraphError` with a `code` property:

| Error Class | Code | When |
|---|---|---|
| `ValidationError` | `VALIDATION_ERROR` | Data fails JSON Schema |
| `RegistryViolationError` | `REGISTRY_VIOLATION` | Triple not registered |
| `InvalidQueryError` | `INVALID_QUERY` | findEdges with no filters |
| `TraversalError` | `TRAVERSAL_ERROR` | run() with zero hops |

```typescript
import { ValidationError, RegistryViolationError } from 'firegraph';

try {
  await g.putNode('task', id, invalidData);
} catch (err) {
  if (err instanceof ValidationError) {
    console.error(err.code, err.details);
  }
}
```

## TypeScript Codegen

Generate types from entity schemas:

```bash
npx firegraph codegen --entities ./entities --out src/graph-types.ts
```

Produces interfaces like `TaskData`, `StepData`, `HasStepEdgeData`.

## Editor

The firegraph editor is a full-stack web UI for browsing and editing graph data. It auto-generates forms from JSON Schemas and renders custom views.

### Launch the editor

```bash
# With a config file (auto-discovered)
npx firegraph editor

# With explicit flags
npx firegraph editor --entities ./entities --emulator --project my-project

# Read-only mode
npx firegraph editor --readonly
```

### Add an npm script

```json
{
  "scripts": {
    "editor": "firegraph editor"
  }
}
```

### Editor features

- Browse all node types with search and filtering
- View/edit node data with schema-validated forms
- Navigate edges (outgoing and incoming) with inverse labels
- Multi-hop traversal builder
- View Gallery for custom Web Component views
- AI chat panel for graph-aware queries (auto-detects `claude` CLI)
- Dark theme UI

### AI Chat (Optional)

The editor includes a built-in chat panel for AI-assisted graph exploration. It auto-detects the `claude` CLI on PATH — no external dependencies or setup required.

When `claude` is found, a **Chat** tab appears in the sidebar. Chat spawns `claude -p` processes on demand with graph-aware system prompts and tool access restricted to `npx firegraph query`.

To customize or disable:

```typescript
// firegraph.config.ts
export default defineConfig({
  entities: './entities',
  chat: {                      // optional — auto-enabled by default
    model: 'haiku',            // default: 'sonnet'
    maxConcurrency: 4,         // default: 2
  },
  // chat: false,              // disables chat even if claude is on PATH
});
```

See [Editor Chat docs](editor-chat.md) for the full guide.

## Custom Views (Optional)

Define Web Component views per entity for rich rendering in the editor.

### Per-entity views.ts

```typescript
// entities/nodes/task/views.ts
class TaskCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact task card';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    this.innerHTML = `<strong>${this._data.title ?? ''}</strong>`;
  }
}

export default [TaskCard]; // MUST be default export of array
```

### React adapter

```tsx
// entities/nodes/task/views.tsx
import { wrapReact } from 'firegraph/react';

const TaskCard = wrapReact(({ data }) => (
  <div style={{ padding: 12 }}>
    <strong>{String(data.title ?? '')}</strong>
  </div>
), { viewName: 'card', description: 'Compact task card' });

export default [TaskCard];
```

### Svelte adapter

```typescript
// entities/nodes/task/views.ts
import { wrapSvelte } from 'firegraph/svelte';
import TaskCard from './TaskCard.svelte';

export default [
  wrapSvelte(TaskCard, { viewName: 'card', description: 'Compact task card' }),
];
```

## Quick-Start Checklist

1. Install: `pnpm add git+ssh://git@github.com:typicalday/firegraph.git firebase-admin` (also `pnpm add -D tsup typescript` for the build step)
2. Create `entities/` directory with nodes and edges subdirectories
3. Define `schema.json` for each node type
4. Define `schema.json` + `edge.json` for each edge type
5. Create `firegraph.config.ts` with `defineConfig()`
6. Set up registry: `discoverEntities()` + `createRegistry()`
7. Create client: `createGraphClient(db, collection, { registry })`
8. Add editor script: `"editor": "firegraph editor"`
9. Optional: add `views.ts` per entity, `sample.json` for gallery
10. Optional: `npx firegraph codegen --entities ./entities --out src/types.ts`
11. Optional: Install `claude` CLI for AI chat in the editor (auto-detected)
