---
paths:
  - "**/entities/**/*"
  - "**/schema.json"
  - "**/edge.json"
  - "**/meta.json"
  - "**/sample.json"
  - "src/discover.ts"
  - "src/codegen/**/*"
---

# Per-Entity Folder Convention

Entities (nodes and edges) are organized in a convention-based directory structure:

```
entities/
  nodes/
    task/
      schema.json        # JSON Schema for data payload (required)
      views.ts           # Web Component view classes (optional)
      sample.json        # Sample data for view gallery (optional)
      meta.json          # Description, view defaults, migrationWriteBack (optional)
      migrations.ts      # MigrationStep[] default export (optional)
    agent/
      schema.json
  edges/
    hasStep/
      schema.json        # JSON Schema for edge data payload (required)
      edge.json          # Topology: from/to + inverseLabel (required)
      views.ts           # (optional)
      migrations.ts      # MigrationStep[] default export (optional)
```

## File Formats

`schema.json` -- Standard JSON Schema describing the `data` payload:
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

`edge.json` -- Topology declaration (replaces old `{ aType, axbType, bType }` triples):
```json
{ "from": "task", "to": "step", "inverseLabel": "stepOf" }
```
`from`/`to` accept string or string[] for edges connecting multiple node types.

For cross-graph edges, add `targetGraph` to declare which subgraph the edge lives in:
```json
{ "from": "task", "to": "agent", "targetGraph": "workflow" }
```
`targetGraph` must be a single segment (no `/`). See `subgraphs.md` for details.

`meta.json` -- Optional description, view defaults, scope constraints, and migration write-back:
```json
{
  "description": "A unit of work",
  "allowedIn": ["root", "**/workspace"],
  "viewDefaults": { "default": "card", "detail": "detail" },
  "migrationWriteBack": "eager"
}
```
`allowedIn` constrains where this type can exist in subgraphs. Patterns: `root`, exact names, `*` (one segment), `**` (zero or more). Omit to allow everywhere.

`migrationWriteBack` enables write-back of migrated data. The schema version is derived automatically as `max(toVersion)` from the `migrations.ts` file. See `migration.md` for details.

`migrations.ts` -- Per-entity migration steps. **Must `export default` a `MigrationStep[]` array:**
```typescript
import type { MigrationStep } from 'firegraph';

const migrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
  { fromVersion: 1, toVersion: 2, up: (d) => ({ ...d, active: true }) },
];

export default migrations;
```

Discovery picks up `migrations.ts` (or `.js`/`.mts`/`.mjs`) automatically. The schema version is derived as `max(toVersion)` from the migrations array.

`views.ts` -- Per-entity Web Component view classes. **Must `export default` an array of view classes:**
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

// IMPORTANT: Must be a default export of an array -- named exports are NOT discovered.
export default [TaskCard];
```

View files can import shared helpers from a sibling or parent `shared.ts`. The editor loads views via two mechanisms:
- **Server (metadata):** `jiti` imports the file; expects `exported.default` (array) or `exported.views` (array)
- **Browser (bundle):** esbuild creates a synthetic entry using default imports from each entity's views.ts

Discovery is handled by `discoverEntities(entitiesDir)` from `src/discover.ts`. It returns a `DiscoveryResult` with `nodes` and `edges` maps, plus warnings for dangling topology references.

## Collections (Plain Firestore)

Collections are plain Firestore collections (outside the graph model) that can be browsed and edited in the editor. They live under `entities/collections/{name}/`:

```
entities/
  collections/
    tourLogs/
      collection.json    # Path template, type discriminator, orderBy (required)
      schema.json        # JSON Schema for document data (optional)
      sample.json        # Sample document data for view gallery (optional)
      views.ts           # Web Component view classes (optional)
```

`collection.json` -- Collection definition (required):
```json
{
  "path": "graph/{tourUid}/logs",
  "description": "Activity log entries for a tour node",
  "typeField": "kind",
  "typeValue": "activity",
  "parentNodeType": "tour",
  "orderBy": { "field": "createdAt", "direction": "desc" }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Firestore collection path. Use `{paramName}` for path parameters. |
| `description` | No | Shown in the sidebar and browse header. |
| `typeField` | No | Field name for type discrimination (e.g. `"kind"`). |
| `typeValue` | No | Value that `typeField` must match. Filters reads, auto-set on writes. |
| `parentNodeType` | No | When set, shows this collection on NodeDetail for matching node type. |
| `orderBy` | No | Default sort: `{ field, direction? }`. Direction defaults to `"asc"`. |

Path parameters are extracted automatically from `{paramName}` tokens. When a user navigates to a parameterized collection, the editor prompts for missing values. Parameter values are validated against `/` injection.

`schema.json` -- Same format as node/edge schemas. When present, the editor generates a typed form for creating/editing documents. When absent, a raw JSON editor is shown.

`views.ts` -- Same format as node/edge views (default export of HTMLElement subclass array). Tag names use `fg-col-{name}-{viewName}` prefix.

`sample.json` -- Sample document data for the View Gallery preview.

Discovery is handled by `discoverCollections(entitiesDir)` from `editor/server/collections-loader.ts`.

## Codegen CLI

Generate TypeScript types from entity JSON Schemas:

```bash
npx firegraph codegen --entities ./entities                        # types to stdout
npx firegraph codegen --entities ./entities --out src/types.ts     # write to file
```

Naming convention: `{PascalName}Data` for nodes (e.g. `TaskData`), `{PascalName}EdgeData` for edges (e.g. `HasStepEdgeData`).
