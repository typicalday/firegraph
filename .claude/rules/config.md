---
paths:
  - '**/firegraph.config.*'
  - 'src/config.ts'
  - 'editor/server/config-loader.ts'
  - 'editor/src/utils.ts'
---

# Configuration

Projects can create a `firegraph.config.ts` (or `.js`/`.mjs`) in their root to consolidate all editor settings.

## Config File

```typescript
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
  viewDefaults: {
    nodes: {
      task: { default: 'card', listing: 'row', detail: 'detail' },
    },
  },
});
```

`defineConfig()` is an identity function for type-checking and autocomplete. Supports default export or named `config` export.

## Config Discovery

1. If `--config <path>` is passed, use that exact file.
2. Otherwise search cwd for `firegraph.config.ts`, `firegraph.config.js`, `firegraph.config.mjs` (in that order).
3. If no config file found, fall back to CLI flags only.

Discovery and loading handled by `editor/server/config-loader.ts` using `jiti`.

## Precedence

`defaults < config file < env vars < CLI flags`

## View Defaults

The `viewDefaults` section defines which view to show by default for each entity type, with optional conditional rules:

- **`default`**: View name to use when no rules match (falls back to `'json'` if unset).
- **`rules`**: Ordered list of `{ when, view }` objects. First rule where ALL `when` conditions match the entity's data wins. Conditions use strict equality on data fields.

View resolution is implemented as a pure function (`resolveView()` in `src/config.ts`, duplicated as `resolveViewForEntity()` in `editor/src/utils.ts` for the client). It only returns view names that exist in the available views.

## Key Files

| File                             | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `src/config.ts`                  | `FiregraphConfig` interface, `defineConfig()`, `resolveView()` |
| `editor/server/config-loader.ts` | `discoverConfigPath()`, `loadConfig()` -- jiti-based loading   |
| `editor/src/utils.ts`            | `resolveViewForEntity()` -- client-side view resolution        |
| `examples/firegraph.config.ts`   | Example config file                                            |
