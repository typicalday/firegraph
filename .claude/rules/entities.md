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
      meta.json          # Description, view defaults (optional)
    agent/
      schema.json
  edges/
    hasStep/
      schema.json        # JSON Schema for edge data payload (required)
      edge.json          # Topology: from/to + inverseLabel (required)
      views.ts           # (optional)
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

`meta.json` -- Optional description, view defaults, and scope constraints:
```json
{
  "description": "A unit of work",
  "allowedIn": ["root", "**/workspace"],
  "viewDefaults": { "default": "card", "detail": "detail" }
}
```
`allowedIn` constrains where this type can exist in subgraphs. Patterns: `root`, exact names, `*` (one segment), `**` (zero or more). Omit to allow everywhere.

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

## Codegen CLI

Generate TypeScript types from entity JSON Schemas:

```bash
npx firegraph codegen --entities ./entities                        # types to stdout
npx firegraph codegen --entities ./entities --out src/types.ts     # write to file
```

Naming convention: `{PascalName}Data` for nodes (e.g. `TaskData`), `{PascalName}EdgeData` for edges (e.g. `HasStepEdgeData`).
