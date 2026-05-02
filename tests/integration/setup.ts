/**
 * Integration-test setup. Two backends are supported behind a single
 * helper (`createTestGraphClient`):
 *
 *   - **Firestore (default)** — connects to the local emulator at
 *     `127.0.0.1:8188`. Each test gets a unique collection path.
 *   - **SQLite (BACKEND=sqlite)** — uses an in-memory `better-sqlite3`
 *     database per `collectionPath`. Multiple `createTestGraphClient(path)`
 *     calls with the same path share the same underlying DB so that
 *     "open two clients against the same data" patterns (used by
 *     migration/registry tests) work identically across backends.
 *
 * Run integration tests against SQLite via `pnpm test:sqlite:integration`.
 *
 * Tests that exercise Firestore-specific behavior (Pipeline mode, Firestore
 * `Timestamp`/`GeoPoint`/`DocumentReference` round-trips, collectionGroup-
 * based cross-graph resolution, etc.) should keep using `getTestFirestore`
 * + `createGraphClient` directly. The new helper is opt-in.
 *
 * **Backend coverage status (2026-04 audit):**
 *   Parameterized via `createTestGraphClient` (run on both Firestore + SQLite):
 *     - client-reads, client-writes, client-edge-cases, client-registry
 *     - batch, transaction, subgraph, traverse, bulk, query-safety
 *   Firestore-only (use raw `createGraphClient(db, …)`):
 *     - cross-graph (uses `resolveAncestorCollection` + path-based subgraph
 *       resolution — SQLite has no nested collection paths)
 *     - migration, migration-dynamic, migration-writeback, dynamic-registry,
 *       merged-registry (mostly backend-agnostic, but several tests reach into
 *       raw subcollection paths like `${collPath}/${parentUid}/graph` — port
 *       to `subgraph()` + `createTestGraphClient` if/when SQLite parity is
 *       wanted there)
 */

import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import type { Database as BetterSqliteDb, default as BetterSqliteDatabase } from 'better-sqlite3';

import { createGraphClientFromBackend } from '../../src/client.js';
import type { SqliteExecutor, SqliteTxExecutor } from '../../src/internal/sqlite-executor.js';
import { buildSchemaStatements } from '../../src/internal/sqlite-schema.js';
import { createSqliteBackend } from '../../src/sqlite/backend.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
} from '../../src/types.js';
import { createGraphClient } from '../helpers/firestore-client.js';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-firegraph';
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1';
const PORT = process.env.FIRESTORE_EMULATOR_PORT || '8188';

// Ensure the emulator host env var is set for @google-cloud/firestore
if (!process.env.FIRESTORE_EMULATOR_HOST?.includes(':')) {
  process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`;
}

const SQLITE_TABLE = 'firegraph_it';

export type TestBackend = 'firestore' | 'sqlite';

export function getTestBackend(): TestBackend {
  const env = process.env.BACKEND?.toLowerCase();
  return env === 'sqlite' ? 'sqlite' : 'firestore';
}

let _db: Firestore | null = null;

export function getTestFirestore(): Firestore {
  if (!_db) {
    _db = new Firestore({ projectId: PROJECT_ID });
  }
  return _db;
}

export function uniqueCollectionPath(): string {
  return `test/${randomUUID()}/graph`;
}

// --- SQLite shared-DB caching ----------------------------------------------

/**
 * One in-memory SQLite database per `collectionPath`. Sharing across
 * `createTestGraphClient` calls with the same path mirrors how Firestore
 * tests open multiple clients against the same data (e.g. the
 * "bare client + registry-aware client" pattern in migration tests).
 */
const _sqliteDbs = new Map<string, BetterSqliteDb>();

async function loadBetterSqlite(): Promise<typeof BetterSqliteDatabase> {
  // Dynamic import so this module doesn't require better-sqlite3 to be
  // installed when running Firestore-only tests in environments that lack
  // native build tools.
  const mod = await import('better-sqlite3');
  return mod.default;
}

let _Database: typeof BetterSqliteDatabase | null = null;

function getOrCreateSqliteDb(collectionPath: string): BetterSqliteDb {
  const cached = _sqliteDbs.get(collectionPath);
  if (cached) return cached;
  if (!_Database) {
    throw new Error(
      'better-sqlite3 not loaded yet. createTestGraphClient must be awaited at least once with a sqlite backend before reusing a path.',
    );
  }
  const db = new _Database(':memory:');
  for (const sql of buildSchemaStatements(SQLITE_TABLE)) {
    db.exec(sql);
  }
  _sqliteDbs.set(collectionPath, db);
  return db;
}

function makeSqliteExecutor(db: BetterSqliteDb): SqliteExecutor {
  return {
    async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
      return db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[];
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as unknown[]));
    },
    async batch(statements): Promise<void> {
      const tx = db.transaction((stmts: typeof statements) => {
        for (const s of stmts) {
          db.prepare(s.sql).run(...(s.params as unknown[]));
        }
      });
      tx(statements);
    },
    async transaction<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T> {
      // Manual BEGIN/COMMIT/ROLLBACK — better-sqlite3's `db.transaction()`
      // requires a sync callback. Rejected promises must roll back.
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({
          async all(sql: string, params: unknown[]) {
            return db.prepare(sql).all(...(params as unknown[])) as Record<string, unknown>[];
          },
          async run(sql: string, params: unknown[]) {
            db.prepare(sql).run(...(params as unknown[]));
          },
        });
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// --- Public helper ---------------------------------------------------------

export interface CreateTestGraphClientOptions extends GraphClientOptions {}

/**
 * Create a `GraphClient` for an integration test. Backend is chosen by the
 * `BACKEND` env var: `'sqlite'` returns a SQLite-backed client (in-memory
 * `better-sqlite3`); anything else (default) returns a Firestore-backed
 * client wired to the local emulator.
 *
 * Multiple calls with the same `collectionPath` share storage so test
 * patterns like "open a bare client and a registry-aware client at the same
 * path" work identically across backends.
 *
 * SQLite caveats — call `skipIfSqlite()` from a `beforeAll` to opt out of:
 *   - Pipeline query mode
 *   - Firestore-specific `Timestamp` / `GeoPoint` / `DocumentReference`
 *     round-trips that depend on the Firestore SDK
 *   - `findEdgesGlobal()` against arbitrary Firestore collection paths
 *     (SQLite uses a single-table materialized-scope layout)
 */
export function createTestGraphClient(
  collectionPath: string,
  options: CreateTestGraphClientOptions & { registryMode: DynamicRegistryConfig },
): DynamicGraphClient;
export function createTestGraphClient(
  collectionPath: string,
  options?: CreateTestGraphClientOptions,
): GraphClient;
export function createTestGraphClient(
  collectionPath: string,
  options?: CreateTestGraphClientOptions,
): GraphClient | DynamicGraphClient {
  if (getTestBackend() === 'sqlite') {
    if (!_Database) {
      throw new Error(
        'SQLite backend requires async setup. Call `await ensureSqliteBackend()` once in a `beforeAll` before using createTestGraphClient.',
      );
    }
    const db = getOrCreateSqliteDb(collectionPath);
    const backend = createSqliteBackend(makeSqliteExecutor(db), SQLITE_TABLE);
    return createGraphClientFromBackend(backend, options) as GraphClient | DynamicGraphClient;
  }
  return createGraphClient(getTestFirestore(), collectionPath, options as GraphClientOptions);
}

/**
 * Lazily import `better-sqlite3`. Call once from a `beforeAll` (cheap,
 * cached) so that subsequent `createTestGraphClient` calls work
 * synchronously. Tests that don't use the SQLite backend can ignore this.
 */
export async function ensureSqliteBackend(): Promise<void> {
  if (getTestBackend() !== 'sqlite') return;
  if (!_Database) {
    _Database = await loadBetterSqlite();
  }
}

/**
 * Skip the current test (and emit a vitest skip) when running under the
 * SQLite backend. Call inside an `it()` body via `if (skipIfSqlite(ctx))
 * return;` — relies on vitest's `ctx.skip()` to surface the skip in the
 * report.
 */
export function skipIfSqlite(ctx: { skip: () => void }): boolean {
  if (getTestBackend() === 'sqlite') {
    ctx.skip();
    return true;
  }
  return false;
}
