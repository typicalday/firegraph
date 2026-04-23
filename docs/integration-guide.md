# Firegraph Integration Guide

Firegraph is a typed graph data layer for Firebase Cloud Firestore. It stores nodes and edges as triples in a Firestore collection with smart query planning, sharded document IDs, JSON Schema validation, multi-hop traversal, and nested subgraphs.

## Installation

Install from the GitHub repository:

```bash
# npm
npm install git+ssh://git@github.com:typicalday/firegraph.git

# pnpm
pnpm add git+ssh://git@github.com:typicalday/firegraph.git
```

Firegraph requires `@google-cloud/firestore` `^8.0.0` as a peer dependency. npm 7+ and pnpm auto-install peer deps.

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

### 1. Initialize Firestore

```typescript
import { Firestore } from '@google-cloud/firestore';

// For production (uses Application Default Credentials automatically)
const db = new Firestore({ projectId: 'my-project' });

// For local development with emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const db = new Firestore({ projectId: 'my-local-project' });
```

### 2. Create a Graph Client

```typescript
import { createGraphClient } from 'firegraph';

// Basic (no validation)
const g = createGraphClient(db, 'my-collection');

// With registry validation (recommended)
const g = createGraphClient(db, 'my-collection', { registry });
```

The second argument specifies the root Firestore collection. All graph data lives here by default; subgraphs extend into nested subcollections beneath individual nodes.

### 3. Create a Configuration File

Create `firegraph.config.ts` in your project root:

```typescript
import { defineConfig } from 'firegraph';

export default defineConfig({
  entities: './entities', // path to entities directory
  project: 'my-project', // Firebase project ID
  collection: 'my-collection', // Firestore collection name
  emulator: '127.0.0.1:8080', // emulator host:port (omit for production)

  editor: {
    port: 3883, // editor server port
    readonly: false, // set true for read-only mode
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
    axbType: 'is', // 'is' = node self-loop
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

### Schema versioning & migrations

Registry entries support `migrations` for automatic data migration on read. The schema version is derived automatically as `max(toVersion)` from the migrations array -- there is no separate `schemaVersion` property to set:

```typescript
import type { MigrationStep } from 'firegraph';

const tourMigrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
  { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, active: true }) },
];

const registry = createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    jsonSchema: tourSchemaV2,
    migrations: tourMigrations, // version derived as max(toVersion) = 2
    migrationWriteBack: 'eager', // persist migrated data back to Firestore
  },
]);
```

When a record is read with `v` behind the derived version, migrations run sequentially in memory. The `v` field lives on the record envelope (not inside `data`), so schemas with `additionalProperties: false` work without special handling.

Write-back modes: `'off'` (default, in-memory only), `'eager'` (fire-and-forget write), `'background'` (errors swallowed). Set globally via `createGraphClient(db, path, { registry, migrationWriteBack: 'background' })` or per entry.

With entity discovery, place `migrations.ts` in the entity folder. Optionally set `migrationWriteBack` in `meta.json`. The schema version is derived from the migrations array automatically:

```
entities/nodes/tour/
  schema.json
  migrations.ts       # export default MigrationStep[]
  meta.json           # { "migrationWriteBack": "eager" }
```

## Dynamic Registry

For agent-driven or runtime-extensible schemas, use **dynamic registry mode**. Instead of defining types in code, agents define node and edge types as graph data itself (meta-nodes). The client compiles these definitions into a live registry on demand.

### Setup

```typescript
import { createGraphClient } from 'firegraph';

const g = createGraphClient(db, 'my-collection', {
  registryMode: { mode: 'dynamic' },
});
```

This returns a `DynamicGraphClient` which extends `GraphClient` with three additional methods: `defineNodeType()`, `defineEdgeType()`, and `reloadRegistry()`.

### Workflow: define → reload → write

```typescript
// 1. Define node types — stored as meta-nodes in the graph
await g.defineNodeType(
  'task',
  {
    type: 'object',
    required: ['title', 'status'],
    properties: {
      title: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['created', 'active', 'completed'] },
    },
    additionalProperties: false,
  },
  'A unit of work',
); // optional description

await g.defineNodeType('step', {
  type: 'object',
  required: ['title', 'order'],
  properties: {
    title: { type: 'string' },
    order: { type: 'integer', minimum: 0 },
  },
});

// 2. Define edge types — topology + optional data schema
await g.defineEdgeType(
  'hasStep',
  { from: 'task', to: 'step', inverseLabel: 'stepOf' },
  { type: 'object', properties: { order: { type: 'integer' } } },
  'Task contains a step',
);

// Optional: define types with schema versioning (version derived from migrations)
await g.defineNodeType('doc', docSchemaV2, 'A document', {
  migrations: [
    { fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, archived: false })' },
    { fromVersion: 1, toVersion: 2, up: '(d) => ({ ...d, tags: [] })' },
  ],
  migrationWriteBack: 'eager',
});

// 3. Compile the registry from stored definitions
await g.reloadRegistry();

// 4. Write domain data — now validated against compiled schemas
await g.putNode('task', taskId, { title: 'Build feature', status: 'created' }); // OK
await g.putNode('task', taskId, { title: 123 }); // throws ValidationError
await g.putNode('booking', bookingId, { total: 500 }); // throws RegistryViolationError
```

### Separate meta-collection

By default, meta-nodes live in the same collection as domain data. To keep them separate:

```typescript
const g = createGraphClient(db, 'my-collection', {
  registryMode: { mode: 'dynamic', collection: 'graph-meta' },
});
```

Meta-nodes are written to `graph-meta`; domain data goes to `my-collection`. When querying domain data, meta-nodes won't appear in results.

### Upsert semantics

Defining the same type twice overwrites the previous definition. After reloading, the latest schema applies:

```typescript
// First definition: name is required
await g.defineNodeType('tour', {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
});

// Second definition: title is required instead
await g.defineNodeType('tour', {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } },
});

await g.reloadRegistry();

await g.putNode('tour', id, { title: 'X' }); // OK — uses latest schema
await g.putNode('tour', id, { name: 'Y' }); // throws ValidationError
```

### Transactions and batches

Transactions and batches validate against the compiled dynamic registry:

```typescript
await g.runTransaction(async (tx) => {
  await tx.putNode('task', taskId, { title: 'TX task', status: 'created' }); // OK
  await tx.putNode('booking', bookingId, { total: 500 }); // throws RegistryViolationError
});

const batch = g.batch();
await batch.putNode('task', taskId, { title: 'Batch task', status: 'created' }); // OK
await batch.commit();
```

### Key behaviors

- **Before `reloadRegistry()`**: Domain writes are rejected (unless in merged mode — see below). Only meta-type writes (`defineNodeType`, `defineEdgeType`) succeed, validated by the bootstrap registry.
- **After `reloadRegistry()`**: Domain writes are validated against the compiled registry. Unknown types are always rejected.
- **Reserved names**: `defineNodeType('nodeType')` and `defineNodeType('edgeType')` throw `DynamicRegistryError` — these names are reserved for the meta-registry itself.
- **Edge topology**: `from` and `to` accept `string | string[]`. Arrays create a cross-product of registry entries (e.g., `from: ['task', 'project'], to: ['step']` registers both `task→hasStep→step` and `project→hasStep→step`).

### Merged registry (static + dynamic)

When both `registry` and `registryMode` are provided, firegraph operates in **merged mode**. The static registry defines the core schema (from your filesystem entities), and the dynamic registry extends it with runtime-defined types. Static entries always take priority.

```typescript
import { createGraphClient, createRegistry, discoverEntities } from 'firegraph';

const { result } = discoverEntities('./entities');
const staticRegistry = createRegistry(result);

const g = createGraphClient(db, 'my-collection', {
  registry: staticRegistry, // core types (immutable at runtime)
  registryMode: { mode: 'dynamic' }, // runtime extensions
});

// Static types work immediately — no reload needed
await g.putNode('task', taskId, { title: 'Build feature', status: 'created' });

// Agents can add new types at runtime
await g.defineNodeType('milestone', milestoneSchema, 'A project milestone');
await g.reloadRegistry();

// Both static and dynamic types are now available
await g.putNode('milestone', milestoneId, { title: 'v1.0' }); // OK
```

Key behaviors in merged mode:

- **Static types are available immediately** — no `reloadRegistry()` needed for types defined in the static registry.
- **Dynamic types extend the schema** — `defineNodeType` and `defineEdgeType` add new types. After `reloadRegistry()`, both static and dynamic types are available.
- **Static entries cannot be overridden** — `defineNodeType('task', ...)` throws `DynamicRegistryError` if `task` is already in the static registry. Same for `defineEdgeType` — all `from`/`to` combinations are checked against the static registry.
- **Static wins on collision** — if a type exists in both registries (e.g., through direct meta-node writes), the static schema is used for validation.
- **Transactions, batches, and subgraphs** all use the merged registry for validation.

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

// Update (partial merge into data)
await g.updateNode(taskId, { status: 'active' });

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

  await tx.updateNode(stepId, { status: 'claimed' });
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

result.nodes; // edges from final hop
result.hops; // per-hop breakdown
result.totalReads; // Firestore reads consumed
result.truncated; // true if budget exceeded
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
  const result = await createTraversal(tx, taskId).follow('hasStep').run();
  // make writes based on traversal results
});
```

## Error Handling

All errors extend `FiregraphError` with a `code` property:

| Error Class              | Code                     | When                                            |
| ------------------------ | ------------------------ | ----------------------------------------------- |
| `ValidationError`        | `VALIDATION_ERROR`       | Data fails JSON Schema                          |
| `RegistryViolationError` | `REGISTRY_VIOLATION`     | Triple not registered                           |
| `MigrationError`         | `MIGRATION_ERROR`        | Migration function fails or chain is incomplete |
| `DynamicRegistryError`   | `DYNAMIC_REGISTRY_ERROR` | Dynamic registry misconfiguration or misuse     |
| `InvalidQueryError`      | `INVALID_QUERY`          | findEdges with no filters                       |
| `TraversalError`         | `TRAVERSAL_ERROR`        | run() with zero hops                            |

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
  chat: {
    // optional — auto-enabled by default
    model: 'haiku', // default: 'sonnet'
    maxConcurrency: 4, // default: 2
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
  set data(v: Record<string, unknown>) {
    this._data = v;
    this.render();
  }
  get data() {
    return this._data;
  }
  connectedCallback() {
    this.render();
  }
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

const TaskCard = wrapReact(
  ({ data }) => (
    <div style={{ padding: 12 }}>
      <strong>{String(data.title ?? '')}</strong>
    </div>
  ),
  { viewName: 'card', description: 'Compact task card' },
);

export default [TaskCard];
```

### Svelte adapter

```typescript
// entities/nodes/task/views.ts
import { wrapSvelte } from 'firegraph/svelte';
import TaskCard from './TaskCard.svelte';

export default [wrapSvelte(TaskCard, { viewName: 'card', description: 'Compact task card' })];
```

## Quick-Start Checklist

1. Install: `pnpm add git+ssh://git@github.com:typicalday/firegraph.git @google-cloud/firestore` (also `pnpm add -D tsup typescript` for the build step)
2. Create `entities/` directory with nodes and edges subdirectories
3. Define `schema.json` for each node type
4. Define `schema.json` + `edge.json` for each edge type
5. Create `firegraph.config.ts` with `defineConfig()`
6. Set up registry: `discoverEntities()` + `createRegistry()`
7. Create client: `createGraphClient(db, collection, { registry })`
8. Add editor script: `"editor": "firegraph editor"`
9. Optional: add `views.ts` per entity, `sample.json` for gallery
10. Optional: add `migrations.ts` for schema evolution (version is derived from migrations automatically)
11. Optional: `npx firegraph codegen --entities ./entities --out src/types.ts`
12. Optional: Install `claude` CLI for AI chat in the editor (auto-detected)
