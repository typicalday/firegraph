/**
 * Cloudflare Durable Object SQLite driver for firegraph.
 *
 * DO SQLite (`ctx.storage.sql`) is a synchronous API exposed inside the
 * Durable Object's single-threaded execution context. firegraph's storage
 * interface is async, so this driver wraps every call in a resolved
 * `Promise`. Interactive transactions go through `ctx.storage.transactionSync`,
 * which fully supports read-then-conditional-write — the migration write-back
 * path inside `runTransaction()` works as it does on Firestore.
 */

import { createGraphClientFromBackend } from './client.js';
import { createSqliteBackend } from './internal/sqlite-backend.js';
import type { SqliteExecutor, SqliteTxExecutor } from './internal/sqlite-executor.js';
import { buildSchemaStatements, validateTableName } from './internal/sqlite-schema.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
} from './types.js';

/**
 * Subset of the Durable Object SQL storage interface that firegraph depends
 * on. Typed against `ctx.storage` from `@cloudflare/workers-types` without
 * importing it.
 */
export interface DOSqlStorage {
  sql: DOSqlExecutor;
  transactionSync<T>(fn: () => T): T;
}

export interface DOSqlExecutor {
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): DOSqlCursor<T>;
}

export interface DOSqlCursor<T> {
  toArray(): T[];
}

export interface DOSqliteClientOptions extends GraphClientOptions {
  /** Table name for firegraph triples (default: `firegraph`). */
  table?: string;
  /** Run schema DDL on first use. Default: `true`. */
  autoMigrate?: boolean;
}

class DOSqliteExecutor implements SqliteExecutor {
  constructor(private readonly storage: DOSqlStorage) {}

  async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.storage.sql.exec<Record<string, unknown>>(sql, ...params).toArray();
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    this.storage.sql.exec(sql, ...params).toArray();
  }

  async batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void> {
    if (statements.length === 0) return;
    this.storage.transactionSync(() => {
      for (const s of statements) {
        this.storage.sql.exec(s.sql, ...s.params).toArray();
      }
    });
  }

  async transaction<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T> {
    // We can't use `transactionSync` here: it requires a synchronous
    // callback, but `fn` is async and may reject only after the sync body
    // has already returned (and the transaction has already committed).
    // Manual `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` lets us await `fn` and
    // still roll back on rejection. `BEGIN IMMEDIATE` acquires the RESERVED
    // lock up front so a concurrent writer can't sneak in between our reads
    // and writes (avoids SQLITE_BUSY mid-transaction).
    this.storage.sql.exec('BEGIN IMMEDIATE').toArray();
    try {
      const txExec: SqliteTxExecutor = {
        all: async (sql: string, params: unknown[]) =>
          this.storage.sql.exec<Record<string, unknown>>(sql, ...params).toArray(),
        run: async (sql: string, params: unknown[]) => {
          this.storage.sql.exec(sql, ...params).toArray();
        },
      };
      const result = await fn(txExec);
      this.storage.sql.exec('COMMIT').toArray();
      return result;
    } catch (err) {
      this.storage.sql.exec('ROLLBACK').toArray();
      throw err;
    }
  }
}

function ensureSchema(storage: DOSqlStorage, table: string): void {
  const statements = buildSchemaStatements(table);
  for (const sql of statements) {
    storage.sql.exec(sql).toArray();
  }
}

export function createDOSqliteGraphClient(
  storage: DOSqlStorage,
  options: DOSqliteClientOptions & { registryMode: DynamicRegistryConfig },
): DynamicGraphClient;
export function createDOSqliteGraphClient(
  storage: DOSqlStorage,
  options?: DOSqliteClientOptions,
): GraphClient;
export function createDOSqliteGraphClient(
  storage: DOSqlStorage,
  options: DOSqliteClientOptions = {},
): GraphClient | DynamicGraphClient {
  const table = options.table ?? 'firegraph';
  validateTableName(table);
  if (options.autoMigrate !== false) {
    ensureSchema(storage, table);
  }

  const executor = new DOSqliteExecutor(storage);
  const backend = createSqliteBackend(executor, table);

  const { table: _t, autoMigrate: _m, ...clientOptions } = options;
  void _t;
  void _m;

  let metaBackend;
  if (
    clientOptions.registryMode &&
    typeof clientOptions.registryMode === 'object' &&
    clientOptions.registryMode.collection &&
    clientOptions.registryMode.collection !== table
  ) {
    const metaTable = clientOptions.registryMode.collection;
    validateTableName(metaTable);
    if (options.autoMigrate !== false) {
      ensureSchema(storage, metaTable);
    }
    metaBackend = createSqliteBackend(executor, metaTable);
  }

  return createGraphClientFromBackend(backend, clientOptions, metaBackend);
}
