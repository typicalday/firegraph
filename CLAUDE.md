# Firegraph — Project Guide

## What This Is

Firegraph is a TypeScript library that provides a graph data model on top of Firebase Cloud Firestore. It stores nodes and edges in a single Firestore collection, with smart query planning, sharded document IDs, optional schema validation, and multi-hop graph traversal.

## Architecture

### Graph Model

Every record in Firestore is a **triple**: `(aType, aUid) -[abType]-> (bType, bUid)`.

- **Nodes** are stored as self-loops: `(tour, tour1) -[is]-> (tour, tour1)`. The special relation `is` (constant `NODE_RELATION`) marks a record as a node.
- **Edges** are standard directed edges: `(tour, tour1) -[hasDeparture]-> (departure, dep1)`.

All records live in a single Firestore collection. Document IDs:
- Nodes: the UID itself (`tour1`)
- Edges: `shard:aUid:abType:bUid` where shard is first hex char of SHA-256 hash (16-bucket distribution to avoid hotspots)

### Key Modules

| File | Purpose |
|------|---------|
| `src/client.ts` | `GraphClientImpl` — main entry point implementing `GraphClient` |
| `src/transaction.ts` | `GraphTransactionImpl` — read/write inside Firestore transactions |
| `src/batch.ts` | `GraphBatchImpl` — atomic batch writes |
| `src/query.ts` | Query planner: routes `FindEdgesParams` to either `get` (direct doc lookup) or `query` (filtered scan) strategy |
| `src/traverse.ts` | Multi-hop graph traversal with budget enforcement and concurrency control |
| `src/registry.ts` | Optional schema registry for type-safe edge validation (JSON Schema via ajv) |
| `src/json-schema.ts` | JSON Schema validation (ajv) and introspection (JSON Schema → `FieldMeta[]`) |
| `src/discover.ts` | Convention-based entity auto-discovery from per-entity folders |
| `src/codegen/index.ts` | TypeScript type generation from JSON Schema (uses `json-schema-to-typescript`) |
| `src/config.ts` | `defineConfig()`, `resolveView()` — project config file types and view resolution |
| `src/views.ts` | `defineViews()` — framework-agnostic model view definitions (Web Components) |
| `src/record.ts` | Builds `GraphRecord` objects with server timestamps |
| `src/docid.ts` | Computes document IDs (passthrough for nodes, sharded hash for edges) |
| `src/id.ts` | 21-char nanoid generation |
| `src/errors.ts` | Error hierarchy: `FiregraphError` base with typed subclasses |
| `src/types.ts` | All TypeScript interfaces and types |
| `src/internal/firestore-adapter.ts` | Low-level Firestore operations (standard, transaction, batch adapters) |
| `src/internal/constants.ts` | `NODE_RELATION = 'is'`, shard config |

### Interfaces

- `GraphReader` — read operations (`getNode`, `getEdge`, `edgeExists`, `findEdges`, `findNodes`)
- `GraphWriter` — write operations (`putNode`, `putEdge`, `updateNode`, `removeNode`, `removeEdge`)
- `GraphClient` — extends both + `runTransaction()` + `batch()`
- `GraphTransaction` — extends both (used inside `runTransaction`)
- `GraphBatch` — extends `GraphWriter` + `commit()`

Both `GraphClient` and `GraphTransaction` implement `GraphReader`, so `createTraversal()` accepts either.

## Development

### Commands

```bash
pnpm build              # tsup → ESM + CJS + DTS in dist/
pnpm typecheck          # tsc --noEmit
pnpm test:unit          # vitest on tests/unit/
pnpm test:emulator      # starts emulator, runs full suite, stops emulator
pnpm test:emulator:unit # emulator + unit tests only
pnpm test:emulator:integration  # emulator + integration tests only
pnpm emulator:start     # manual emulator start (demo-firegraph, port 8188)
pnpm emulator:stop      # kill emulator
```

### Testing

- **Unit tests** (`tests/unit/`): Pure logic, no Firestore. Mock `GraphReader` for traverse tests.
- **Integration tests** (`tests/integration/`): Real Firestore emulator. Each test gets a unique collection path via `uniqueCollectionPath()`.
- **Setup**: `tests/integration/setup.ts` initializes firebase-admin against `127.0.0.1:8188`.
- **Fixtures**: `tests/helpers/fixtures.ts` has `tourData`, `departureData`, `riderData`, etc.

### Build

- tsup with `esm` + `cjs` dual format
- Target: Node 18+
- External: `firebase-admin`, `json-schema-to-typescript`
- Entry: `src/index.ts`, `src/codegen/index.ts`

### Dependencies

- **Runtime**: `nanoid` (ID generation), `ajv` (JSON Schema validation)
- **Peer**: `firebase-admin` (required)
- **Dev**: `json-schema-to-typescript` (codegen CLI)

### Per-Entity Folder Convention

Entities (nodes and edges) are organized in a convention-based directory structure:

```
entities/
  nodes/
    task/
      schema.json        # JSON Schema for data payload (required)
      views.ts           # Web Component view classes (optional)
      sample.json        # Sample data for view gallery (optional)
      meta.json          # Description, view defaults (optional)
    agent/
      schema.json
  edges/
    hasStep/
      schema.json        # JSON Schema for edge data payload (required)
      edge.json          # Topology: from/to + inverseLabel (required)
      views.ts           # (optional)
```

**File formats:**

`schema.json` — Standard JSON Schema describing the `data` payload:
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

`edge.json` — Topology declaration (replaces old `{ aType, abType, bType }` triples):
```json
{ "from": "task", "to": "step", "inverseLabel": "stepOf" }
```
`from`/`to` accept string or string[] for edges connecting multiple node types.

`meta.json` — Optional description and view defaults:
```json
{ "description": "A unit of work", "viewDefaults": { "default": "card", "detail": "detail" } }
```

`views.ts` — Per-entity Web Component view classes. **Must `export default` an array of view classes:**
```typescript
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

class TaskRow extends HTMLElement {
  static viewName = 'row';
  // ...
}

// IMPORTANT: Must be a default export of an array — named exports are NOT discovered.
export default [TaskCard, TaskRow];
```

View files can import shared helpers from a sibling or parent `shared.ts`. The editor loads views via two mechanisms:
- **Server (metadata):** `jiti` imports the file; expects `exported.default` (array) or `exported.views` (array)
- **Browser (bundle):** esbuild creates a synthetic entry using default imports from each entity's views.ts

See `examples/entities/nodes/tour/views.ts` and `examples/entities/edges/hasDeparture/views.ts` for working examples.

Discovery is handled by `discoverEntities(entitiesDir)` from `src/discover.ts`. It returns a `DiscoveryResult` with `nodes` and `edges` maps, plus warnings for dangling topology references.

### Codegen CLI

Generate TypeScript types from entity JSON Schemas:

```bash
npx firegraph codegen --entities ./entities                        # types to stdout
npx firegraph codegen --entities ./entities --out src/types.ts     # write to file
```

Naming convention: `{PascalName}Data` for nodes (e.g. `TaskData`), `{PascalName}EdgeData` for edges (e.g. `HasStepEdgeData`).

### Schema Validation

Registry validation uses JSON Schema (via ajv). Each `RegistryEntry` has an optional `jsonSchema` field:

```typescript
createRegistry([
  { aType: 'tour', abType: 'is', bType: 'tour', jsonSchema: tourSchema },
  { aType: 'tour', abType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema, inverseLabel: 'departureOf' },
]);
```

Alternatively, pass a `DiscoveryResult` directly:
```typescript
const { result } = discoverEntities('./entities');
const registry = createRegistry(result);
```

### Inverse Labels

Edge entries support an optional `inverseLabel` field — a display-only label for when an edge is viewed from the B-side (incoming direction). This does not create a real inverse edge; it's purely cosmetic for the editor UI.

```typescript
createRegistry([
  { aType: 'project', abType: 'hasTask', bType: 'task', jsonSchema: taskEdgeSchema, inverseLabel: 'taskOf' },
  { aType: 'task',    abType: 'hasStep', bType: 'step', jsonSchema: stepEdgeSchema, inverseLabel: 'stepOf' },
]);
```

In the editor, incoming edges with an `inverseLabel` display:
- `— stepOf →` (amber color, arrow reads left-to-right) instead of `← hasStep —`
- Hovering the label shows a tooltip: "Inverse of: hasStep"
- Without `inverseLabel`, the existing `← abType —` display is preserved

The label flows through: `RegistryEntry.inverseLabel` → `introspectRegistry()` → `GET /api/schema` → frontend `EdgeType.inverseLabel` → `NodeDetail.tsx` + `DrillBreadcrumb.tsx`.

## Editor

The `editor/` directory contains a full-stack web UI for browsing and editing graph data. It is registry-aware: when given an entities directory or registry file, it introspects JSON Schemas to generate forms and validates all writes through the registry.

### Editor Architecture

| Directory | Purpose |
|-----------|---------|
| `editor/server/index.ts` | Express server — reads (raw Firestore queries), writes (via `GraphClient` for registry validation) |
| `editor/server/config-loader.ts` | Discovers and loads `firegraph.config.ts` via `jiti` |
| `editor/server/entities-loader.ts` | Loads per-entity views via `jiti`, builds `ViewRegistry`, merges view defaults |
| `editor/server/schema-introspect.ts` | Converts JSON Schema → `FieldMeta[]` for form generation |
| `editor/server/schema-views-validator.ts` | Validates sample data against JSON Schemas, detects orphaned views |
| `editor/server/views-bundler.ts` | esbuild bundles per-entity views into browser-loadable ES module |
| `editor/src/` | React 19 + React Router + Tailwind CSS frontend |
| `editor/src/components/SchemaForm.tsx` | Dynamic form generator from `FieldMeta[]` |
| `editor/src/components/NodeEditor.tsx` | Create/edit node form |
| `editor/src/components/EdgeEditor.tsx` | Create edge form |
| `editor/src/components/CustomView.tsx` | React wrapper for rendering Web Component views |
| `editor/src/components/ViewSwitcher.tsx` | Tab bar for switching between JSON and custom views |
| `editor/src/components/ViewGallery.tsx` | Storybook-like preview page for all registered views |

### Editor Commands

```bash
pnpm build:all         # build library + editor
pnpm build:editor      # build editor only (client + server)
pnpm dev:editor        # dev mode (Express :3884 + Vite :3883)
npx firegraph editor   # run production editor (auto-discovers firegraph.config.ts)
npx firegraph editor --config ./custom.ts   # explicit config path
npx firegraph editor --entities ./entities  # per-entity folder convention
npx firegraph codegen --entities ./entities --out src/types.ts  # generate TS types
```

### Editor Build Pipeline

- **Client**: Vite → `dist/editor/client/` (React SPA)
- **Server**: esbuild → `dist/editor/server/index.mjs` (Express + cors bundled in; firebase-admin, jiti, esbuild external)
- **CLI**: `bin/firegraph.mjs` dispatches subcommands (`editor`, `codegen`)

### Model Views

Model views let projects define **multiple, purpose-driven visual representations** for each entity type. Instead of always displaying raw JSON, the editor can render nodes and edges through custom views tailored to specific use cases — an "executive summary" for a user, a "card" for compact display, a "timeline entry" for a departure.

Views are **framework-agnostic**: they are standard Web Components (Custom Elements), not React components. They work in any environment that supports the DOM. The data contract for each view is the `data` shape defined by the entity's JSON Schema.

#### Concept

Every firegraph record has a `data: Record<string, unknown>` payload whose shape is defined by the entity's JSON Schema. A view is simply a different way to render that same data. One entity type can have many views, each showing the data from a different angle or for a different audience.

```
Registry schema (contract)     Views (presentation)
┌──────────────────────┐      ┌─────────────┐
│ user                 │      │ card         │  compact display
│   displayName: str   │─────▶│ profile      │  full profile
│   email: str         │      │ executive    │  executive summary
│   role: enum         │      │ admin        │  admin panel
└──────────────────────┘      └─────────────┘
```

#### View Component Contract

Each view is a class that extends `HTMLElement` and satisfies this interface:

```typescript
interface ViewComponentClass {
  new (...args: any[]): { data: Record<string, unknown> };
  viewName: string;        // required — short identifier (e.g. 'card')
  description?: string;    // optional — shown in gallery and tooltips
}
```

In practice, a view component looks like this:

```typescript
class UserCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact user card';

  private _data: Record<string, unknown> = {};

  // The editor sets this property when rendering the view.
  // The data shape matches the entity's JSON Schema.
  set data(value: Record<string, unknown>) {
    this._data = value;
    this.render();
  }

  get data() {
    return this._data;
  }

  // Called when the element is added to the DOM
  connectedCallback() {
    this.render();
  }

  private render() {
    const d = this._data;
    this.innerHTML = `
      <div style="padding: 12px; border-radius: 8px; background: #1e293b;">
        <strong>${d.displayName ?? ''}</strong>
        <div style="font-size: 12px; color: #94a3b8;">${d.email ?? ''}</div>
      </div>
    `;
  }
}
```

Key rules:
- The `data` setter must trigger a re-render (the editor will call it whenever data changes)
- `connectedCallback()` should also render (for initial mount)
- Use inline styles or Shadow DOM for styling — the view runs inside the editor's page
- The component receives only the `data` portion of the record, never the firegraph fields (aType, aUid, etc.)

#### `defineViews()` API

The `defineViews()` factory function takes a `ViewRegistryInput` and returns a `ViewRegistry`. Import it from `firegraph`:

```typescript
import { defineViews } from 'firegraph';
```

**Input shape:**

```typescript
interface ViewRegistryInput {
  nodes?: Record<string, EntityViewConfig>;  // keyed by aType
  edges?: Record<string, EntityViewConfig>;  // keyed by abType
}

interface EntityViewConfig {
  views: ViewComponentClass[];
  sampleData?: Record<string, Record<string, unknown>>;  // keyed by viewName
}
```

**Output shape:**

```typescript
interface ViewRegistry {
  nodes: Record<string, EntityViewMeta>;
  edges: Record<string, EntityViewMeta>;
}

interface EntityViewMeta {
  views: ViewMeta[];
  sampleData?: Record<string, Record<string, unknown>>;
}

interface ViewMeta {
  tagName: string;       // auto-generated, e.g. 'fg-user-card'
  viewName: string;      // from the component's static viewName
  description?: string;  // from the component's static description
}
```

**Dual-environment behaviour:**
- **Browser**: `defineViews()` calls `customElements.define()` for each view class, registering it with a deterministic tag name. The tag name format is `fg-{entityType}-{viewName}` for nodes and `fg-edge-{abType}-{viewName}` for edges.
- **Node.js (server)**: `defineViews()` only returns metadata. No DOM APIs are called. This is how the editor server extracts view metadata without a browser.

#### Creating a Views File

**Per-entity `views.ts` files** (see "Per-Entity Folder Convention" above) are the standard approach. Each entity's `views.ts` exports a default array of view classes. Sample data lives in `sample.json` next to it.

**Monolithic views file** using `defineViews()` is also possible for standalone use. Create a TypeScript file in your project (e.g. `src/views.ts`). It must export a `ViewRegistry` — either as the default export, a named `views` export, or any named export.

```typescript
// src/views.ts
import { defineViews } from 'firegraph';

class UserCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact user card';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    const d = this._data;
    this.innerHTML = `<strong>${d.displayName ?? ''}</strong>`;
  }
}

class UserProfile extends HTMLElement {
  static viewName = 'profile';
  static description = 'Full user profile';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    const d = this._data;
    this.innerHTML = `
      <div>
        <h3>${d.displayName ?? ''}</h3>
        <p>${d.email ?? ''}</p>
        <span>Role: ${d.role ?? '—'}</span>
      </div>
    `;
  }
}

// Edge view example — keyed by abType
class ManagesEntry extends HTMLElement {
  static viewName = 'summary';
  static description = 'Management relationship summary';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    this.innerHTML = `<span>Since: ${this._data.since ?? '—'}</span>`;
  }
}

export default defineViews({
  nodes: {
    user: {
      views: [UserCard, UserProfile],
      sampleData: {
        card: { displayName: 'Jamie Chen', email: 'jamie@example.com', role: 'admin' },
        profile: { displayName: 'Jamie Chen', email: 'jamie@example.com', role: 'admin' },
      },
    },
  },
  edges: {
    manages: {
      views: [ManagesEntry],
      sampleData: {
        summary: { since: '2024-01-15' },
      },
    },
  },
});
```

**Key points:**
- Node views are keyed by `aType` (the entity type name from your registry)
- Edge views are keyed by `abType` (the relation name from your registry)
- `sampleData` is keyed by `viewName` — each view can have its own sample data for the gallery
- `sampleData` is optional — the gallery will show an empty object if not provided, and you can paste data in manually

#### Tag Name Generation

`defineViews()` generates deterministic custom element tag names from the entity type and view name:

| Entity | View | Generated Tag |
|--------|------|---------------|
| Node `user`, view `card` | `fg-user-card` |
| Node `user`, view `profile` | `fg-user-profile` |
| Node `tourDeparture`, view `badge` | `fg-tourdeparture-badge` |
| Edge `hasDeparture`, view `timeline` | `fg-edge-hasdeparture-timeline` |
| Edge `manages`, view `summary` | `fg-edge-manages-summary` |

Non-alphanumeric characters are replaced with hyphens. Consecutive hyphens are collapsed.

#### Running the Editor with Views

The simplest way is to use a `firegraph.config.ts` (see **Configuration** section below):

```bash
npx firegraph editor   # auto-discovers firegraph.config.ts
```

Or pass flags directly:

```bash
npx firegraph editor --entities ./entities --collection graph

# With emulator
npx firegraph editor --entities ./entities --emulator --project demo-project
```

Without per-entity `views.ts` files, the editor shows raw JSON. With views, it shows view switchers wherever views are registered.

#### What Happens at Startup

1. **Metadata extraction**: `entities-loader.ts` uses `jiti` to import each per-entity `views.ts` in Node.js. A shim for `HTMLElement` is injected so view classes can be loaded without a browser. The loader reads the default export (array of view classes) and extracts metadata (tag names, view names, descriptions).

2. **Browser bundle**: `views-bundler.ts` generates a synthetic entry point that imports all per-entity `views.ts` files and calls `defineViews()`. This is bundled with `esbuild` into a single ES module (`format: 'esm'`, `platform: 'browser'`, `target: 'es2022'`). A browser-safe shim replaces the `firegraph` import. The bundle is kept in memory (`write: false`), minified, and given a content hash for caching.

3. **API endpoints**: Two endpoints are registered:
   - `GET /api/views` — returns the view metadata as JSON:
     ```json
     {
       "nodes": {
         "user": {
           "views": [
             { "tagName": "fg-user-card", "viewName": "card", "description": "Compact user card" },
             { "tagName": "fg-user-profile", "viewName": "profile", "description": "Full user profile" }
           ],
           "sampleData": {
             "card": { "displayName": "Jamie Chen", "email": "jamie@example.com" }
           }
         }
       },
       "edges": { ... },
       "hasViews": true
     }
     ```
   - `GET /api/views/bundle` — returns the compiled JavaScript with `Content-Type: application/javascript`, `Cache-Control: public, max-age=3600`, and an `ETag` header.

4. **Frontend loading**: `App.tsx` fetches `/api/views` in parallel with schema and config. If `hasViews` is `true`, it injects a `<script type="module" src="/api/views/bundle">` into the document head. When the browser executes this script, `defineViews()` runs in a browser context — this time `customElements` exists, so all view classes are registered as custom elements.

#### Editor Integration Points

**Node detail page** (`/node/:uid`): The "Data" section header gains a `ViewSwitcher` toolbar showing `[JSON] [card] [profile]`. Clicking a view name replaces the `JsonView` with a `CustomView` wrapper that creates the corresponding custom element and sets its `.data` property.

**Edge rows**: When viewing a node's outgoing or incoming edges, each edge row can switch between JSON and custom views if views are registered for that edge's `abType`. Resolved inline nodes also show view switchers if views are registered for their `aType`.

**View Gallery page** (`/views`): A Storybook-like page accessible from the sidebar (the "Views" link appears only when views are loaded). It lists all entity types with views, showing:
- Entity type badge (node/edge) and name
- Number of registered views
- "Edit sample data" toggle — opens a JSON textarea where you can modify sample data live
- A grid of all views for that type, each rendered with its sample data
- Tag name shown in monospace for reference

#### `CustomView` React Wrapper

`CustomView.tsx` bridges React and Web Components. It:
1. Creates a `<div>` container via a React ref
2. Imperatively creates the custom element (`document.createElement(tagName)`)
3. Appends it to the container
4. Sets `.data = { ... }` on the element whenever data changes
5. Replaces the element if the tagName changes
6. Cleans up on unmount

This approach avoids React's VDOM conflicting with the custom element's internal DOM management.

#### Styling Views

Views run inside the editor's page, so they share the page's CSS environment. Options for styling:

- **Inline styles** (simplest): Use `style="..."` attributes directly in the HTML. This is what the example views do.
- **Shadow DOM** (isolated): Call `this.attachShadow({ mode: 'open' })` in the constructor, then render into `this.shadowRoot`. Styles inside the shadow root won't leak out or be affected by the editor's styles.
- **Adopted stylesheets**: Create a `CSSStyleSheet`, set its rules, and add it to `this.shadowRoot.adoptedStyleSheets`. This is the most performant approach for Shadow DOM.

The editor's background is dark (slate-950), so views that use a dark color scheme will blend in naturally.

#### Example Views Files

See `examples/entities/nodes/tour/views.ts` and `examples/entities/edges/hasDeparture/views.ts` for working per-entity views. See `examples/07-model-views.ts` for a comprehensive example using the monolithic `defineViews()` API directly.

#### Dependencies

The views system adds `esbuild` as a runtime dependency (used by the server to bundle views on startup). It is listed in the root `package.json` `dependencies` alongside `jiti` and `nanoid`. Both `esbuild` and `jiti` are marked as externals in the editor server build (`editor/build-server.mjs`) since they require native binaries / dynamic requires that break when bundled.

## Configuration

Projects can create a `firegraph.config.ts` (or `.js`/`.mjs`) in their root to consolidate all editor settings. This is the Vite-style approach — no CLI flags needed when a config file exists.

### Config File

```typescript
// firegraph.config.ts
import { defineConfig } from 'firegraph';

export default defineConfig({
  entities: './entities',
  project: 'my-project',
  collection: 'graph',
  emulator: '127.0.0.1:8080',

  editor: {
    port: 3883,
    readonly: false,
  },

  // Optional: override per-entity meta.json viewDefaults from config
  viewDefaults: {
    nodes: {
      task: { default: 'card', listing: 'row', detail: 'detail' },
    },
  },
});
```

`defineConfig()` is an identity function that provides type-checking and autocomplete. The file can use either a default export or a named `config` export.

### Config Discovery

1. If `--config <path>` is passed, use that exact file.
2. Otherwise search cwd for `firegraph.config.ts`, `firegraph.config.js`, `firegraph.config.mjs` (in that order).
3. If no config file found, fall back to CLI flags only.

Discovery and loading is handled by `editor/server/config-loader.ts` using `jiti`.

### Precedence

`defaults < config file < env vars < CLI flags`

CLI flags always win. Config file fills in what's not specified on the command line. This means `npx firegraph editor` with a config file present just works, and `npx firegraph editor --readonly` overrides the config file's `readonly: false`.

### View Defaults

The `viewDefaults` section defines which view to show by default for each entity type, with optional conditional rules:

- **`default`**: View name to use when no rules match (falls back to `'json'` if unset).
- **`rules`**: Ordered list of `{ when, view }` objects. First rule where ALL `when` conditions match the entity's data wins. Conditions use strict equality on data fields.

View resolution is implemented as a pure function (`resolveView()` in `src/config.ts`, duplicated as `resolveViewForEntity()` in `editor/src/utils.ts` for the client). It only returns view names that exist in the available views — unknown view names are silently skipped.

### Key Files

| File | Purpose |
|------|---------|
| `src/config.ts` | `FiregraphConfig` interface, `defineConfig()`, `resolveView()` |
| `editor/server/config-loader.ts` | `discoverConfigPath()`, `loadConfig()` — jiti-based loading |
| `editor/src/utils.ts` | `resolveViewForEntity()` — client-side view resolution |
| `examples/firegraph.config.ts` | Example config file |

## Conventions

- All source in `src/`, all tests in `tests/`
- `.js` extensions in imports (ESM resolution)
- Prefer interfaces over classes for public API surfaces
- Factory functions (`createGraphClient`, `createTraversal`, `createRegistry`, `defineViews`, `defineConfig`, `discoverEntities`) over `new`
- Errors extend `FiregraphError` with a string `code`
- No default exports
- Internal modules live in `src/internal/`

## Common Patterns

### Query Planning

`buildEdgeQueryPlan` checks if all three identifying fields (`aUid`, `abType`, `bUid`) are present. If so, it returns a `get` strategy (single doc lookup). Otherwise, it builds Firestore `where` filters from whichever fields are provided.

### Adapter Pattern

Three adapters (`FirestoreAdapter`, `TransactionAdapter`, `BatchAdapter`) provide the same interface over different Firestore execution contexts. The client/transaction/batch classes delegate to these adapters.

### Traversal

`createTraversal(reader, startUid)` returns a builder. `.follow(abType, opts)` adds hops. `.run(opts)` executes sequentially hop-by-hop, with parallel fan-out within each hop controlled by a semaphore. Budget (`maxReads`) is checked before each Firestore call.
