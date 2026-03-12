---
paths:
  - "**/dynamic-registry*"
  - "**/dynamic*registry*"
  - "src/client.ts"
---

# Dynamic Registry

The dynamic registry allows agents to define new node and edge types at runtime by storing type definitions as graph data itself.

## Concept

Type definitions are stored as regular firegraph nodes using two reserved meta-types:
- **`nodeType`** -- defines a node type (name + JSON Schema + optional description)
- **`edgeType`** -- defines an edge type (name + topology + optional JSON Schema)

A **bootstrap registry** (hardcoded) validates writes to these meta-types. After defining types, calling `reloadRegistry()` compiles them into a full registry that validates domain data writes.

```
Agent workflow:
  defineNodeType('milestone', schema)   <- validated by bootstrap registry
  defineEdgeType('hasMilestone', ...)   <- validated by bootstrap registry
  reloadRegistry()                      <- compiles meta-nodes -> GraphRegistry
  putNode('milestone', uid, data)       <- validated by compiled registry
```

## Usage

```typescript
import { createGraphClient, generateId } from 'firegraph';

const client = createGraphClient(db, 'graph', {
  registryMode: { mode: 'dynamic' },
});

await client.defineNodeType('milestone', {
  type: 'object',
  required: ['title', 'date'],
  properties: {
    title: { type: 'string', minLength: 1 },
    date: { type: 'string' },
    status: { type: 'string', enum: ['planned', 'reached'] },
  },
  additionalProperties: false,
}, 'A project milestone');

await client.defineEdgeType(
  'hasMilestone',
  { from: 'project', to: 'milestone', inverseLabel: 'milestoneOf' },
  { type: 'object', properties: { order: { type: 'number' } } },
  'Projects have milestones',
);

// Cross-graph edge: targetGraph tells traversal which subgraph to query
await client.defineEdgeType(
  'assignedTo',
  { from: 'task', to: 'agent', targetGraph: 'workflow' },
  { type: 'object', properties: { role: { type: 'string' } } },
  'Task assigned to an agent in a workflow subgraph',
);

await client.reloadRegistry();
```

## Separate Meta-Collection

```typescript
const client = createGraphClient(db, 'graph', {
  registryMode: { mode: 'dynamic', collection: 'graph_meta' },
});
```

When `collection` is set, meta-type writes go to the meta-collection, domain writes to main collection.

## How It Works

**Meta-type data shapes:**
- `nodeType`: `{ "name": "milestone", "jsonSchema": { ... }, "description": "..." }`
- `edgeType`: `{ "name": "hasMilestone", "from": "project", "to": "milestone", "jsonSchema": { ... }, "inverseLabel": "milestoneOf", "targetGraph": "milestones" }`

`from`/`to` accept `string | string[]`. `targetGraph` is optional -- when set, forward traversal queries this subgraph under the source node. Must be a single segment (no `/`, validated by JSON Schema pattern `^[^/]+$`).

**Deterministic UIDs:** SHA-256 hash of `nodeType:tour` truncated to 21 chars. Calling `defineNodeType` again upserts the same document.

**Validation routing:**
- Meta-type writes always validated against hardcoded bootstrap registry
- Domain writes validated against compiled dynamic registry
- Before `reloadRegistry()`, domain writes are rejected (`RegistryViolationError`)

**Reserved names:** `defineNodeType('nodeType')` and `defineNodeType('edgeType')` throw `DynamicRegistryError`.

**Mutual exclusivity:** Providing both `registry` (static) and `registryMode` (dynamic) throws `DynamicRegistryError`.

## Standalone Compilation

```typescript
import { createGraphClient, createRegistryFromGraph } from 'firegraph';

const metaReader = createGraphClient(db, 'graph_meta');
const registry = await createRegistryFromGraph(metaReader);
const client = createGraphClient(db, 'graph', { registry });
```

## Key Files

| File | Purpose |
|------|---------|
| `src/dynamic-registry.ts` | Bootstrap schemas, `createRegistryFromGraph()`, `generateDeterministicUid()`, meta-type constants |
| `src/client.ts` | `DynamicGraphClient` implementation: validation routing, convenience methods, meta-reader |
| `src/types.ts` | `DynamicGraphClient`, `DynamicRegistryConfig`, `NodeTypeData`, `EdgeTypeData` interfaces |
| `src/errors.ts` | `DynamicRegistryError` |
| `tests/unit/dynamic-registry.test.ts` | Unit tests |
| `tests/integration/dynamic-registry.test.ts` | Integration tests |
