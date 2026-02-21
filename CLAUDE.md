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
| `src/registry.ts` | Optional schema registry for type-safe edge validation (works with Zod) |
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
- External: `firebase-admin`, `zod`
- Entry: `src/index.ts`

### Dependencies

- **Runtime**: `nanoid` (ID generation)
- **Peer**: `firebase-admin` (required), `zod` (optional, for registry schemas)

## Editor

The `editor/` directory contains a full-stack web UI for browsing and editing graph data. It is registry-aware: when given a path to a project's registry file, it introspects Zod schemas to generate forms and validates all writes through the registry.

### Editor Architecture

| Directory | Purpose |
|-----------|---------|
| `editor/server/index.ts` | Express server — reads (raw Firestore queries), writes (via `GraphClient` for registry validation) |
| `editor/server/registry-loader.ts` | Dynamic TypeScript import of user's registry file via `jiti` |
| `editor/server/schema-introspect.ts` | Walks Zod `._def` tree to extract field metadata (`FieldMeta[]`) |
| `editor/src/` | React 19 + React Router + Tailwind CSS frontend |
| `editor/src/components/SchemaForm.tsx` | Dynamic form generator from `FieldMeta[]` |
| `editor/src/components/NodeEditor.tsx` | Create/edit node form |
| `editor/src/components/EdgeEditor.tsx` | Create edge form |

### Editor Commands

```bash
pnpm build:all         # build library + editor
pnpm build:editor      # build editor only (client + server)
pnpm dev:editor        # dev mode (Express :3884 + Vite :3883)
npx firegraph editor   # run production editor
```

### Editor Build Pipeline

- **Client**: Vite → `dist/editor/client/` (React SPA)
- **Server**: esbuild → `dist/editor/server/index.mjs` (Express + cors bundled in; firebase-admin, zod, jiti external)
- **CLI**: `bin/firegraph.mjs` dispatches subcommands (`editor`)

## Conventions

- All source in `src/`, all tests in `tests/`
- `.js` extensions in imports (ESM resolution)
- Prefer interfaces over classes for public API surfaces
- Factory functions (`createGraphClient`, `createTraversal`, `createRegistry`) over `new`
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
