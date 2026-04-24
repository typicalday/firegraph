# Firegraph — Project Guide

Firegraph is a TypeScript library that provides a graph data model on top of Firebase Cloud Firestore. It stores nodes and edges as triples in a Firestore collection (with optional nested subcollections for subgraphs), featuring smart query planning, sharded document IDs, optional schema validation, and multi-hop graph traversal.

## Commands

```bash
pnpm build              # tsup -> ESM + CJS + DTS in dist/
pnpm typecheck          # tsc --noEmit
pnpm test:unit          # vitest on tests/unit/
pnpm test:emulator      # starts emulator, runs full suite, stops emulator
pnpm test:emulator:unit # emulator + unit tests only
pnpm test:emulator:integration  # emulator + integration tests only
pnpm emulator:start     # manual emulator start (demo-firegraph, port 8188)
pnpm emulator:stop      # kill emulator
pnpm build:all          # build library + editor
pnpm dev:editor         # dev mode (Express :3884 + Vite :3883)
```

## Build

- tsup with `esm` + `cjs` dual format, target Node 18+
- External: `@google-cloud/firestore`, `json-schema-to-typescript`
- Entry: `src/index.ts`, `src/codegen/index.ts`
- Runtime deps: `nanoid` (ID generation), `@cfworker/json-schema` (JSON Schema validation, draft 2020-12 — runtime interpreter, no `new Function()` codegen, Cloudflare-Workers-compatible)
- Peer dep: `@google-cloud/firestore` `^8.0.0`

## Conventions

- All source in `src/`, all tests in `tests/`
- `.js` extensions in imports (ESM resolution)
- Prefer interfaces over classes for public API surfaces
- Factory functions (`createGraphClient`, `createTraversal`, `createRegistry`, `createRegistryFromGraph`, `createBootstrapRegistry`, `defineViews`, `defineConfig`, `discoverEntities`) over `new`
- Errors extend `FiregraphError` with a string `code`
- No default exports
- Internal modules live in `src/internal/`

## Post-Change Audits

After completing a large change (new feature, multi-file refactor, or anything touching 5+ files), automatically run the `/audit` slash command before considering the work done. Do not ask -- just run it. This applies especially to changes touching core paths like client.ts, transaction.ts, query.ts, bulk.ts, or traverse.ts, and any change that adds new public API surface.

## Detailed Rules

Context-specific rules are in `.claude/rules/` and load automatically when working on matching files:

| Rule file             | Loads when editing                                                                                                                                         | Content                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `architecture.md`     | Always                                                                                                                                                     | Graph model, key modules, interfaces                                         |
| `core-library.md`     | `src/**/*.ts`                                                                                                                                              | Query planning, adapters, dual-mode engine, traversal                        |
| `testing.md`          | `tests/**/*`                                                                                                                                               | Test types, emulator setup, fixtures                                         |
| `entities.md`         | `**/entities/**/*`, `**/schema.json`, `**/edge.json`                                                                                                       | Per-entity folder convention, codegen CLI                                    |
| `views.md`            | `**/views*.ts`, `**/views*.tsx`, `**/*.svelte`                                                                                                             | Model views, defineViews, React/Svelte adapters                              |
| `subgraphs.md`        | `src/scope.ts`, `src/client.ts`, `src/bulk.ts`, `tests/**/subgraph*`, `tests/**/scope*`                                                                    | Subgraph scoping, allowedIn patterns, cascade delete                         |
| `routing.md`          | `src/backend.ts`, `src/scope-path.ts`, `src/internal/routing-backend.ts`, `tests/**/routing-backend*`, `tests/**/scope-path*`, `tests/**/backend-surface*` | `createRoutingBackend`, storage-scope helpers, cross-backend atomicity rules |
| `dynamic-registry.md` | `**/dynamic-registry*`, `**/dynamic*registry*`                                                                                                             | Bootstrap, meta-types, runtime type definition                               |
| `editor.md`           | `editor/**/*`                                                                                                                                              | Editor architecture, server, frontend, build pipeline                        |
| `config.md`           | `**/firegraph.config.*`, `**/config*.ts`                                                                                                                   | defineConfig, discovery, view defaults                                       |
| `migration.md`        | `**/migration*`, `**/sandbox*`, `**/migrations*`                                                                                                           | Schema versioning, auto-migration, write-back                                |
