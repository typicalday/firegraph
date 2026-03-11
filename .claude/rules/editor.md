---
paths:
  - "editor/**/*"
  - "bin/**/*"
---

# Editor

The `editor/` directory contains a full-stack web UI for browsing and editing graph data. It is registry-aware: when given an entities directory or registry file, it introspects JSON Schemas to generate forms and validates all writes through the registry.

## Architecture

| Directory | Purpose |
|-----------|---------|
| `editor/server/index.ts` | Express server -- reads (raw Firestore queries), writes (via `GraphClient` for registry validation) |
| `editor/server/config-loader.ts` | Discovers and loads `firegraph.config.ts` via `jiti` |
| `editor/server/entities-loader.ts` | Loads per-entity views via `jiti`, builds `ViewRegistry`, merges view defaults |
| `editor/server/schema-introspect.ts` | Converts JSON Schema -> `FieldMeta[]` for form generation |
| `editor/server/schema-views-validator.ts` | Validates sample data against JSON Schemas, detects orphaned views |
| `editor/server/views-bundler.ts` | esbuild bundles per-entity views into browser-loadable ES module |
| `editor/src/` | React 19 + React Router + Tailwind CSS frontend |
| `editor/src/components/SchemaForm.tsx` | Dynamic form generator from `FieldMeta[]` |
| `editor/src/components/NodeEditor.tsx` | Create/edit node form |
| `editor/src/components/EdgeEditor.tsx` | Create edge form |
| `editor/src/components/CustomView.tsx` | React wrapper for rendering Web Component views |
| `editor/src/components/ViewSwitcher.tsx` | Tab bar for switching between JSON and custom views |
| `editor/src/components/ViewGallery.tsx` | Storybook-like preview page for all registered views |

## Commands

```bash
pnpm build:all         # build library + editor
pnpm build:editor      # build editor only (client + server)
pnpm dev:editor        # dev mode (Express :3884 + Vite :3883)
npx firegraph editor   # run production editor (auto-discovers firegraph.config.ts)
npx firegraph editor --config ./custom.ts   # explicit config path
npx firegraph editor --entities ./entities  # per-entity folder convention
npx firegraph codegen --entities ./entities --out src/types.ts  # generate TS types
```

## Build Pipeline

- **Client**: Vite -> `dist/editor/client/` (React SPA)
- **Server**: esbuild -> `dist/editor/server/index.mjs` (Express + cors bundled in; @google-cloud/firestore, jiti, esbuild external)
- **CLI**: `bin/firegraph.mjs` dispatches subcommands (`editor`, `codegen`)
