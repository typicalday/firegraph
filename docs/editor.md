# Firegraph Editor — Integration Guide

The Firegraph Editor is a full-stack web UI for browsing and editing graph data stored in Firestore. It requires a project registry file to operate: it knows every node type, edge type, and Zod validation rule from the registry, generates forms accordingly, and validates all writes through the registry before reaching Firestore.

## Quick Start

```bash
# From your project directory (where your registry file lives)
npx firegraph editor --registry ./path/to/registry.ts --collection graph
```

This starts the editor at `http://localhost:3883`. It imports your TypeScript registry file, introspects every Zod schema, and serves a React UI with auto-generated forms for creating and editing data.

## Prerequisites

- **Node.js 18+**
- **firebase-admin** installed in your project (peer dependency)
- **zod** installed in your project (peer dependency)
- **Authentication**: Either Application Default Credentials (`gcloud auth application-default login`) or the Firestore emulator running

The editor resolves `firebase-admin` and `zod` from your project's `node_modules` at runtime. `jiti` (used to import TypeScript registry files) is included as a dependency of firegraph. Everything else (Express, React, etc.) is bundled inside firegraph.

## Registry Requirement

The `--registry` flag is **required**. The editor will exit with an error if no registry is provided. The registry gives the editor:

- **Schema discovery** — knows every node type, edge type, and their relationships without sampling documents (zero Firestore reads on startup)
- **Form generation** — builds input forms from Zod schemas (text fields, number inputs, enum dropdowns, checkboxes, nested objects, arrays)
- **Write validation** — all creates and updates go through `GraphClient.putNode()` / `GraphClient.putEdge()`, which validates against the registry before writing to Firestore
- **Constraint display** — shows min/max, required/optional, enum options, regex patterns directly in the form UI

```bash
npx firegraph editor --registry ./src/registry.ts --collection my-graph
```

Use `--readonly` to prevent writes even with a registry loaded:

```bash
npx firegraph editor --registry ./src/registry.ts --collection my-graph --readonly
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--registry <path>` | *(required)* | Path to TypeScript file exporting a `GraphRegistry` |
| `--project <id>` | *(auto-detect via ADC)* | GCP project ID |
| `--collection <path>` | `graph` | Firestore collection path |
| `--port <number>` | `3883` | Server port |
| `--emulator [host:port]` | *(none)* | Use Firestore emulator (default: `127.0.0.1:8080`) |
| `--readonly` | `false` | Force read-only mode |

Flags also respect environment variables:

| Env Var | Maps To |
|---------|---------|
| `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT` | `--project` |
| `FIREGRAPH_COLLECTION` | `--collection` |
| `FIRESTORE_EMULATOR_HOST` | `--emulator` |
| `PORT` | `--port` |

## Writing a Registry File

The editor expects a TypeScript file that exports a `GraphRegistry` — either as the default export or as a named export called `registry`.

```typescript
// src/registry.ts
import { createRegistry } from 'firegraph';
import { z } from 'zod';

// 1. Define Zod schemas for your node data
const tourSchema = z.object({
  name: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  maxRiders: z.number().int().positive(),
});

const departureSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['draft', 'open', 'closed', 'completed']),
  maxCapacity: z.number().int().positive(),
});

// 2. Define Zod schemas for edge data (can be empty)
const orderEdge = z.object({ order: z.number().int().min(0) });
const emptyEdge = z.object({});

// 3. Register every valid triple
export const registry = createRegistry([
  // Nodes — abType 'is' marks a node entry
  { aType: 'tour',      abType: 'is', bType: 'tour',      dataSchema: tourSchema,      description: 'A cycling tour' },
  { aType: 'departure', abType: 'is', bType: 'departure', dataSchema: departureSchema, description: 'A scheduled departure' },

  // Edges — define valid relationships
  { aType: 'tour', abType: 'hasDeparture', bType: 'departure', dataSchema: orderEdge,  description: 'Tour has a departure' },
  { aType: 'tour', abType: 'hasGuide',     bType: 'user',      dataSchema: emptyEdge,  description: 'Tour has a guide' },
]);
```

**Key rules:**
- Nodes are registered with `abType: 'is'` and `aType === bType`
- Every edge triple `(aType, abType, bType)` must be explicitly registered
- `dataSchema` is optional but recommended — without it, any data payload is accepted
- `description` is optional but shows up in the editor UI for context

### Export Conventions

The editor accepts either of these patterns:

```typescript
// Named export (preferred)
export const registry = createRegistry([...]);

// Default export
export default createRegistry([...]);
```

## How Schema Introspection Works

When the editor loads your registry, it walks each Zod schema's internal `._def` tree to extract serializable field metadata. This happens server-side — the React frontend receives plain JSON describing each field.

**Supported Zod types and what they produce:**

| Zod Type | Editor Input | Extracted Constraints |
|----------|-------------|----------------------|
| `z.string()` | Text input | `minLength`, `maxLength`, `pattern` |
| `z.number()` | Number input | `min`, `max`, `isInt` (step=1 for integers) |
| `z.boolean()` | Checkbox | — |
| `z.enum([...])` | Select dropdown | `enumValues` |
| `z.array(...)` | Repeatable group with add/remove | `itemMeta` (recursive) |
| `z.object({...})` | Nested fieldset | `fields` (recursive) |
| `z.optional(...)` | Marked as optional | `required: false` |
| `z.default(...)` | Unwrapped to inner type | *(default value not shown)* |
| `z.nullable(...)` | Marked as optional | `required: false` |

Unsupported types (unions, intersections, transforms, etc.) fall back to a JSON textarea where you can enter raw JSON.

### The `FieldMeta` Structure

Every field is represented as:

```typescript
interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'unknown';
  required: boolean;
  description?: string;
  enumValues?: string[];          // for enums
  minLength?: number;             // for strings
  maxLength?: number;
  pattern?: string;               // regex source
  min?: number;                   // for numbers
  max?: number;
  isInt?: boolean;
  itemMeta?: FieldMeta;           // for arrays (describes each item)
  fields?: FieldMeta[];           // for nested objects
}
```

This is what the frontend receives via `GET /api/schema` and uses to render the `SchemaForm` component.

## Browse Toolbar

The node browse page includes a toolbar with:

- **Limit selector** — choose how many results per page (10, 25, 50, 100)
- **Sort control** — sort by UID, createdAt, or updatedAt in ascending or descending order
- **Filter** — filter by data subfields (e.g., `status == active`) using equality and comparison operators
- **Pagination** — Previous/Next page navigation with page indicator
- **Refresh** — re-fetch the current view

## Write Operations

When the editor is not in `--readonly` mode, it exposes these capabilities:

### Creating Nodes

1. Navigate to a node type's browse page
2. Click "Create {type}"
3. Fill in the auto-generated form (fields come from your Zod schema)
4. Optionally provide a custom UID (auto-generated if blank)
5. Submit — the editor calls `graphClient.putNode(aType, uid, data)`

If validation fails (Zod rejects the data or the triple isn't registered), the error is shown inline without writing to Firestore.

### Editing Nodes

1. Navigate to a node's detail page
2. Click "Edit"
3. Modify fields in the form
4. Submit — calls `graphClient.putNode(aType, uid, updatedData)`

### Deleting Nodes

1. On a node's detail page, click "Delete"
2. Confirm in the dialog
3. The editor calls `graphClient.removeNode(uid)`

### Creating Edges

1. On a node's detail page, click "Add Edge"
2. Select the edge type (filtered to valid triples for this node type)
3. Enter the target node UID
4. Fill in any edge data fields
5. Submit — calls `graphClient.putEdge(aType, aUid, abType, bType, bUid, data)`

### Deleting Edges

1. On a node's detail page, find the edge in the outgoing/incoming lists
2. Click the delete button on the edge row
3. Confirm — calls `graphClient.removeEdge(aUid, abType, bUid)`

## Using with the Firestore Emulator

For local development, point the editor at your emulator:

```bash
# Start your emulator (example)
firebase emulators:start -P demo-project

# Start the editor against it
npx firegraph editor \
  --registry ./src/registry.ts \
  --emulator 127.0.0.1:8080 \
  --project demo-project \
  --collection graph
```

The `--emulator` flag accepts an optional `host:port` argument. If omitted, it defaults to `127.0.0.1:8080`. You can also just pass `--emulator` with no value if the default port is correct.

## API Reference

The editor server exposes these endpoints (useful if you want to script interactions):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Server configuration (project, collection, readonly) |
| `GET` | `/api/schema` | Full schema with field metadata from registry (zero Firestore reads) |
| `GET` | `/api/nodes?type=X&limit=25&sortBy=aUid&sortDir=asc` | Browse nodes by type with sorting, filtering, pagination |
| `GET` | `/api/node/:uid` | Single node with outgoing and incoming edges |
| `GET` | `/api/edges?aType=X&abType=Y` | Query edges with optional filters |
| `GET` | `/api/search?q=term` | Search by UID (exact match + aUid/bUid lookups) |
| `POST` | `/api/traverse` | Multi-hop graph traversal |
| `POST` | `/api/node` | Create a node `{ aType, uid?, data }` |
| `PUT` | `/api/node/:uid` | Update a node `{ data }` |
| `DELETE` | `/api/node/:uid` | Delete a node |
| `POST` | `/api/edge` | Create an edge `{ aType, aUid, abType, bType, bUid, data }` |
| `DELETE` | `/api/edge` | Delete an edge `{ aUid, abType, bUid }` |

### Browse endpoint query params

| Param | Default | Description |
|-------|---------|-------------|
| `type` | — | Node type to filter by |
| `limit` | `25` | Results per page (max 200) |
| `startAfter` | — | Cursor for pagination |
| `sortBy` | `aUid` | Sort field: `aUid`, `createdAt`, `updatedAt` |
| `sortDir` | `asc` | Sort direction: `asc` or `desc` |
| `filterField` | — | Data subfield to filter (e.g., `status` or `data.status`) |
| `filterOp` | — | Comparison operator: `==`, `!=`, `<`, `<=`, `>`, `>=` |
| `filterValue` | — | Value to compare against |

Write endpoints return `403` when in read-only mode, and `400` with structured error details when validation fails.

## Adding an npm Script

Add a convenience script to your project's `package.json`:

```json
{
  "scripts": {
    "editor": "firegraph editor --registry ./src/registry.ts --collection graph",
    "editor:emulator": "firegraph editor --registry ./src/registry.ts --collection graph --emulator --project demo-project"
  }
}
```

Then just run:

```bash
npm run editor
# or
npm run editor:emulator
```

## Real-World Example: IVE Multi-Agent System

Here's how a real project integrates the editor. IVE is a multi-agent task orchestration system built on firegraph with 6 node types and 7 edge types:

```typescript
// skill/scripts/registry.ts
import { createRegistry } from 'firegraph';
import { z } from 'zod';

const taskData = z.object({
  title: z.string(),
  description: z.string(),
  status: z.enum(['created', 'decomposing', 'active', 'completed', 'failed']),
  architect: z.string().optional(),
});

const stepData = z.object({
  title: z.string(),
  description: z.string(),
  status: z.enum(['created', 'claimed', 'completed', 'failed']),
  order: z.number().int().min(0),
  result: z.string().optional(),
  error: z.string().optional(),
});

// ... more schemas ...

export const iveRegistry = createRegistry([
  { aType: 'task', abType: 'is', bType: 'task', dataSchema: taskData },
  { aType: 'step', abType: 'is', bType: 'step', dataSchema: stepData },
  { aType: 'task', abType: 'hasStep', bType: 'step', dataSchema: z.object({ order: z.number().int().min(0) }) },
  { aType: 'step', abType: 'blockedBy', bType: 'step', dataSchema: z.object({}) },
  // ... more entries ...
]);
```

Launch the editor:

```bash
npx firegraph editor \
  --registry ./skill/scripts/registry.ts \
  --emulator 127.0.0.1:52918 \
  --project ive-local \
  --collection ive
```

The editor will show all 6 node types with their Zod-derived forms, let you create tasks and steps with validated data, and visualize the task decomposition graph through the traversal builder.

## Troubleshooting

### "Failed to import registry file"

The editor uses [jiti](https://github.com/nicolo-ribaudo/jiti) to import TypeScript files at runtime. Common causes:

- **Missing dependencies**: Your registry file imports from packages not installed in the project. Make sure `firegraph` and `zod` are installed.
- **Path resolution**: The `--registry` path is resolved relative to `cwd`. Use a relative path from where you run the command.
- **Syntax errors**: jiti compiles TypeScript on the fly. Check your registry file for syntax issues.

### "Registry must export a GraphRegistry"

The editor looks for:
1. A `default` export
2. A named export called `registry`

Make sure your file exports a `GraphRegistry` object (the return value of `createRegistry()`).

### "--registry is required"

The editor no longer supports discovery mode (running without a registry). You must provide a `--registry` flag pointing to a TypeScript file that exports a `GraphRegistry`.

### Connection errors

- **Production Firestore**: Run `gcloud auth application-default login` and make sure you have access to the project.
- **Emulator**: Make sure the emulator is running and the `--emulator` host:port matches. The editor sets `FIRESTORE_EMULATOR_HOST` internally.
- **Wrong collection**: Double-check `--collection` matches the collection path your app uses.

### Port already in use

The default port is 3883. Use `--port` to pick a different one:

```bash
npx firegraph editor --registry ./src/registry.ts --port 4000
```
