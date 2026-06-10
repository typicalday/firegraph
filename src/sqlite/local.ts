/**
 * Local SQLite backend over `better-sqlite3`.
 *
 * This entry point is published as `firegraph/sqlite-local` and is the only
 * module in the library that references `better-sqlite3` — keep it out of
 * `firegraph/sqlite` so that D1 / workerd bundles never see the native
 * dependency. `better-sqlite3` is loaded via dynamic `import()` at factory
 * call time, so merely importing this module stays side-effect free.
 *
 * The factory accepts either a database file path (`':memory:'` works) or an
 * already-open `better-sqlite3` Database. Path-opened databases get
 * `journal_mode = WAL` and a `busy_timeout` applied; caller-provided
 * databases are used as-is (only `busy_timeout` is set) since the caller
 * owns their pragma configuration.
 */

import type { Database as BetterSqliteDb, default as BetterSqliteDatabase } from 'better-sqlite3';

import { FiregraphError } from '../errors.js';
import type { StorageBackend } from '../internal/backend.js';
import type { SqliteExecutor, SqliteTxExecutor } from '../internal/sqlite-executor.js';
import type { SqliteBackendOptions, SqliteCapability } from './backend.js';
import { createSqliteBackend } from './backend.js';

export interface LocalSqliteBackendOptions extends SqliteBackendOptions {
  /** Root graph table name. Defaults to `'firegraph'`. */
  tableName?: string;
  /**
   * `PRAGMA busy_timeout` in milliseconds — how long a connection waits on a
   * lock held by another process before erroring. Defaults to 5000.
   */
  busyTimeoutMs?: number;
  /**
   * Extra pragmas applied after the defaults, e.g.
   * `{ synchronous: 'NORMAL', cache_size: -64000 }`. Applied in object
   * order via `PRAGMA <key> = <value>`.
   */
  pragmas?: Record<string, string | number>;
  /**
   * When opening by path: throw if the file does not already exist instead
   * of creating it. Defaults to false.
   */
  fileMustExist?: boolean;
}

export interface LocalSqliteBackend {
  /** The graph storage backend — pass to `createGraphClient`. */
  backend: StorageBackend<SqliteCapability>;
  /** The underlying better-sqlite3 database, for raw access. */
  db: BetterSqliteDb;
  /**
   * Close the database. No-op when the factory was given an already-open
   * Database (the caller owns its lifecycle).
   */
  close(): void;
}

/**
 * Build a transaction-capable `SqliteExecutor` over a better-sqlite3
 * Database. Interactive transactions use manual `BEGIN IMMEDIATE` /
 * `COMMIT` / `ROLLBACK` because `db.transaction()` requires a synchronous
 * callback while `SqliteExecutor.transaction` callbacks are async.
 *
 * Exported for callers that want to wire `createSqliteBackend` directly
 * (e.g. to share one executor across several root tables).
 */
export function createBetterSqliteExecutor(db: BetterSqliteDb): SqliteExecutor {
  return {
    async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async batch(statements): Promise<void> {
      const tx = db.transaction((stmts: typeof statements) => {
        for (const s of stmts) {
          db.prepare(s.sql).run(...s.params);
        }
      });
      tx(statements);
    },
    async transaction<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({
          async all(sql: string, params: unknown[]) {
            return db.prepare(sql).all(...params) as Record<string, unknown>[];
          },
          async run(sql: string, params: unknown[]) {
            db.prepare(sql).run(...params);
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

function isDatabase(value: unknown): value is BetterSqliteDb {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { exec?: unknown }).exec === 'function'
  );
}

const PRAGMA_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function applyPragmas(db: BetterSqliteDb, pragmas: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(pragmas)) {
    if (!PRAGMA_KEY_PATTERN.test(key)) {
      throw new FiregraphError(`Invalid pragma name: ${JSON.stringify(key)}`, 'INVALID_ARGUMENT');
    }
    db.pragma(`${key} = ${value}`);
  }
}

/**
 * Open (or wrap) a local SQLite database and return a graph storage backend
 * over it.
 *
 * ```typescript
 * import { createLocalSqliteBackend } from 'firegraph/sqlite-local';
 * import { createGraphClient } from 'firegraph/sqlite';
 *
 * const { backend, close } = await createLocalSqliteBackend('./graph.db');
 * const client = createGraphClient(backend);
 * // ... use the client ...
 * close();
 * ```
 *
 * Requires `better-sqlite3` to be installed (declared as an optional peer
 * dependency). The factory is async because the driver is loaded via
 * dynamic `import()`.
 */
export async function createLocalSqliteBackend(
  pathOrDb: string | BetterSqliteDb,
  options: LocalSqliteBackendOptions = {},
): Promise<LocalSqliteBackend> {
  const {
    tableName = 'firegraph',
    busyTimeoutMs = 5000,
    pragmas,
    fileMustExist,
    ...backendOptions
  } = options;

  let db: BetterSqliteDb;
  let ownsDb: boolean;
  if (typeof pathOrDb === 'string') {
    let Database: typeof BetterSqliteDatabase;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch (err) {
      throw new FiregraphError(
        `createLocalSqliteBackend requires the optional peer dependency 'better-sqlite3' — install it to use the local SQLite backend (${
          err instanceof Error ? err.message : String(err)
        })`,
        'MISSING_DEPENDENCY',
      );
    }
    db = new Database(pathOrDb, fileMustExist ? { fileMustExist: true } : {});
    ownsDb = true;
    // WAL lets concurrent readers coexist with a writer — the right default
    // for a long-lived local graph file. On ':memory:' databases SQLite
    // reports 'memory' and ignores the request, which is fine.
    db.pragma('journal_mode = WAL');
  } else if (isDatabase(pathOrDb)) {
    db = pathOrDb;
    ownsDb = false;
  } else {
    throw new FiregraphError(
      'createLocalSqliteBackend expects a file path or an open better-sqlite3 Database',
      'INVALID_ARGUMENT',
    );
  }

  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (pragmas) {
    applyPragmas(db, pragmas);
  }

  const backend = createSqliteBackend(createBetterSqliteExecutor(db), tableName, backendOptions);
  let closed = false;
  return {
    backend,
    db,
    close(): void {
      if (closed || !ownsDb) return;
      closed = true;
      db.close();
    },
  };
}
