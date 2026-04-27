# Schema Versioning & Auto-Migration

Firegraph supports schema versioning with automatic migration of records on read. The schema version is derived automatically as `max(toVersion)` from the `migrations` array -- there is no separate `schemaVersion` field. When a record's stored version (`v`) is behind the derived version, migration functions run automatically to bring data up to the current version.

## Version Storage

The version number lives on the record envelope as a top-level `v` field (not inside `data`). Records without `v` are treated as version 0 (legacy data). Since `v` is metadata separate from the user's data payload, schemas with `additionalProperties: false` work without any special handling.

## Static Registry (Code-Defined)

Static migrations are in-memory JavaScript/TypeScript functions with full access to imports, async, DB calls, etc. They never go through the sandbox.

```typescript
import { createRegistry, createGraphClient } from 'firegraph';
import type { MigrationStep } from 'firegraph';

const migrations: MigrationStep[] = [
  { fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, status: d.status ?? 'draft' }) },
  {
    fromVersion: 1,
    toVersion: 2,
    up: async (d) => {
      // Full power: imports, async, DB calls, etc.
      return { ...d, active: true };
    },
  },
];

const registry = createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    jsonSchema: tourSchemaV2,
    migrations,
    migrationWriteBack: 'eager', // optional
  },
]);
// Schema version is derived as max(toVersion) from migrations = 2
```

## Dynamic Registry (Stored in Firestore)

Dynamic migrations are stored as source code strings in Firestore. They are compiled at `reloadRegistry()` time via a configurable sandbox executor.

The default executor uses [SES (Secure ECMAScript)](https://github.com/endojs/endo/tree/master/packages/ses) Compartments with JSON marshaling, running in a **dedicated worker thread** so that `lockdown()` does not affect the main process's intrinsics. This provides robust isolation:

1. **Worker-thread confinement:** `lockdown()` runs in a separate V8 isolate (via `node:worker_threads`). The main process's built-in prototypes remain unmodified.
2. **Hardened primordials:** `lockdown()` freezes all intrinsics inside the worker, preventing prototype pollution.
3. **No ambient authority:** Each compartment has its own `globalThis` with no host APIs (`process`, `require`, `fetch`, `setTimeout`, etc.).
4. **No dynamic code generation:** SES statically rejects direct `eval()` and `import()` expressions at compile time.
5. **No prototype escapes:** Data enters/exits the compartment as JSON strings, preventing cross-context prototype chain attacks.

```typescript
await client.defineNodeType('tour', tourSchema, 'A tour', {
  migrations: [{ fromVersion: 0, toVersion: 1, up: '(d) => ({ ...d, status: "draft" })' }],
  migrationWriteBack: 'eager',
});
// Version is derived as max(toVersion) = 1
await client.reloadRegistry();
```

**Worker thread details:** The sandbox worker is spawned lazily on first `defaultExecutor` call and is `unref()`'d so it doesn't prevent process exit. Each migration function call communicates with the worker via `postMessage`, making all `defaultExecutor` results async (compatible with `MigrationFn`'s `Promise` return type). The worker is shared across all migration executions and maintains its own compiled function cache. Use `destroySandboxWorker()` in test teardown to terminate the worker explicitly.

**Firestore type preservation:** The default executor transparently preserves Firestore special types (`Timestamp`, `GeoPoint`, `VectorValue`, `DocumentReference`) through the JSON serialization boundary. Before entering the worker, Firestore types are wrapped in tagged plain objects (sentinel key `__firegraph_ser__`). After the migration returns, tagged objects are reconstructed into real Firestore types. Migration functions see tagged representations (e.g., `{ __firegraph_ser__: 'Timestamp', seconds: N, nanoseconds: N }`) and can read/modify the underlying values or create new tagged objects. `DocumentReference` requires a `Firestore` instance for reconstruction — this happens at write-back time; in the executor output, references stay tagged. Custom executors run in-process and receive raw Firestore objects directly (no serialization needed). See `src/serialization.ts`.

**Self-contained constraint:** Stored migration strings cannot use `import`, `require`, or reference external modules. They must be pure data transformations. The default sandbox enforces this — only JSON-serializable values (plus tagged Firestore types) survive the context boundary.

**Custom executor:** Pass `migrationSandbox` to `createGraphClient()` to override the default SES executor:

```typescript
const client = createGraphClient(db, 'graph', {
  registryMode: { mode: 'dynamic' },
  migrationSandbox: (source) => {
    // Custom executor — e.g., a compartment with additional endowments
    const c = new Compartment({ JSON, myHelper: harden(myHelper) });
    return c.evaluate(`(${source})`);
  },
});
```

## Migration Pipeline (Read Path)

1. Record is read from Firestore
2. `migrateRecord()` looks up the registry entry for `(aType, axbType, bType)`
3. If entry has migrations and `record.v < derivedVersion` (where derivedVersion = max toVersion), run migration chain
4. `applyMigrationChain()` sorts migrations by `fromVersion`, applies sequentially
5. Migrated record gets `v = targetVersion` stamped on the envelope
6. Write-back fires if configured (see below)

## Version Stamping (Write Path)

When writing via `putNode`/`putEdge`/`replaceNode`/`replaceEdge` (client, transaction, or batch), if the registry entry has migrations, the record is stamped with `v = max(toVersion)` at the top level (alongside `aType`, `data`, etc.) before storage. Stamping is independent of merge-vs-replace mode — it applies to every full-record write that goes through `writeNode`/`writeEdge`.

## `updateNode` / `updateEdge` and Version Stamping

`updateNode` and `updateEdge` are raw partial updates that do not go through the registry or stamp `v`. This is intentional — partial updates operate on individual fields (now with deep-merge semantics in 0.12) and should not require full schema context. If a record was migrated in-memory and the caller then uses `updateNode`/`updateEdge`, the `v` in Firestore stays at its previous value. The next read will re-trigger migration, which is idempotent. To avoid redundant re-migrations when rewriting the full data payload, use `replaceNode` (or `replaceEdge`) — these are the explicit wipe-and-rewrite methods in 0.12 and they stamp `v`. Note: `putNode` is now a deep merge and is no longer the right tool for full-payload rewrites.

## Write-Back

Write-back controls whether migrated data is persisted back to Firestore after a read-triggered migration.

**Two-tier resolution:** `entry.migrationWriteBack > client.migrationWriteBack > 'off'`

| Mode           | Behavior                                                               |
| -------------- | ---------------------------------------------------------------------- |
| `'off'`        | In-memory only; Firestore document unchanged                           |
| `'eager'`      | Fire-and-forget write after read (client); inline update (transaction) |
| `'background'` | Same as eager but errors are swallowed with a `console.warn`           |

```typescript
// Global default
const g = createGraphClient(db, 'graph', {
  registry,
  migrationWriteBack: 'background',
});

// Entry-level override (takes priority)
createRegistry([
  {
    aType: 'tour',
    axbType: 'is',
    bType: 'tour',
    migrations,
    migrationWriteBack: 'eager',
  },
]);
```

## Entity Discovery

Place a `migrations.ts` (or `.js`/`.mts`/`.mjs`) file in the entity folder. It must default-export a `MigrationStep[]` array. Optionally set `migrationWriteBack` in `meta.json`. The schema version is derived automatically as `max(toVersion)` from the migrations array.

```
entities/nodes/tour/
  schema.json
  migrations.ts       # export default [{ fromVersion: 0, toVersion: 1, up: ... }]
  meta.json           # { "migrationWriteBack": "eager" }
```

## Key Types

```typescript
type MigrationFn = (
  data: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  up: MigrationFn;
}

interface StoredMigrationStep {
  fromVersion: number;
  toVersion: number;
  up: string; // source code string for dynamic registry
}

type MigrationExecutor = (source: string) => MigrationFn;
type MigrationWriteBack = 'off' | 'eager' | 'background';
```

## Key Files

| File                                            | Purpose                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/migration.ts`                              | `applyMigrationChain`, `migrateRecord`, `migrateRecords`                                                 |
| `src/sandbox.ts`                                | `defaultExecutor`, `compileMigrationFn`, `compileMigrations`, `precompileSource`, `destroySandboxWorker` |
| `src/serialization.ts`                          | `serializeFirestoreTypes`, `deserializeFirestoreTypes`, `SERIALIZATION_TAG`, `isTaggedValue`             |
| `src/registry.ts`                               | Migration field propagation, validation                                                                  |
| `src/client.ts`                                 | Read-path migration, write-path version stamping, write-back                                             |
| `src/transaction.ts`                            | Migration on transaction reads, version stamping on writes                                               |
| `src/batch.ts`                                  | Version stamping on batch writes                                                                         |
| `src/dynamic-registry.ts`                       | Stored migration schemas, compilation at reload                                                          |
| `src/discover.ts`                               | `migrations.ts` file detection and loading                                                               |
| `src/errors.ts`                                 | `MigrationError`                                                                                         |
| `tests/unit/migration.test.ts`                  | Unit tests for migration pipeline                                                                        |
| `tests/unit/sandbox.test.ts`                    | Unit tests for sandbox compilation + Firestore type round-trips                                          |
| `tests/unit/serialization.test.ts`              | Unit tests for tagged serialization                                                                      |
| `tests/integration/migration.test.ts`           | Static registry migration integration tests                                                              |
| `tests/integration/migration-dynamic.test.ts`   | Dynamic registry migration integration tests                                                             |
| `tests/integration/migration-writeback.test.ts` | Write-back integration tests                                                                             |
