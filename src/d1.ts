/**
 * Cloudflare D1 driver for firegraph.
 *
 * D1 is async, prepared-statement-based, and supports atomic multi-statement
 * batches via `db.batch()`. D1 has no interactive transactions — reads and
 * conditional writes cannot be interleaved, so `GraphClient.runTransaction()`
 * will throw `UNSUPPORTED_OPERATION` on this driver. Use `GraphClient.batch()`
 * or migrate to Durable Object SQLite for interactive transactions.
 *
 * **Bulk-delete atomicity:** `db.batch()` is atomic *within* one batch but D1
 * caps batches at ~100 statements / 1000 bound parameters. The shared SQLite
 * backend chunks `removeNodeCascade` and `bulkRemoveEdges` automatically; each
 * chunk retries with exponential backoff (`BulkOptions.maxRetries`, default 3).
 * Cross-chunk atomicity is *not* guaranteed — a hub node with thousands of
 * edges may have some chunks commit and others fail. Both operations are
 * idempotent (re-deleting an already-deleted row is a no-op), so callers can
 * safely retry on partial failure. Inspect `result.errors` to detect it.
 */

import { createGraphClientFromBackend } from './client.js';
import { createSqliteBackend } from './internal/sqlite-backend.js';
import type { SqliteExecutor } from './internal/sqlite-executor.js';
import { buildSchemaStatements, validateTableName } from './internal/sqlite-schema.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
} from './types.js';

/**
 * Subset of the Cloudflare D1 Database interface that firegraph depends on.
 * Typed against the official `@cloudflare/workers-types` shape without
 * importing it, so this module has no runtime dependency on the Workers SDK.
 */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}

export interface D1ClientOptions extends GraphClientOptions {
  /** Table name for firegraph triples (default: `firegraph`). */
  table?: string;
  /**
   * Run `CREATE TABLE IF NOT EXISTS …` statements on first use.
   * Default: `true`. Disable if you manage schema via a migration tool.
   */
  autoMigrate?: boolean;
}

class D1Executor implements SqliteExecutor {
  /**
   * D1 caps `db.batch()` at roughly 100 statements (and ~1000 bound
   * parameters across them). The SqliteBackend uses this hint to chunk
   * large cascade/bulk delete operations so a hub node with thousands of
   * edges doesn't trigger a hard rejection.
   */
  readonly maxBatchSize = 100;
  /**
   * D1's secondary cap: total bound parameters across the batch. Cascade
   * deletes are 2 params each (well under the limit) but the chunker
   * respects this defensively if a future statement type pushes through
   * `executeChunkedBatches` with a higher per-statement param count.
   */
  readonly maxBatchParams = 1000;

  constructor(private readonly db: D1Database) {}

  async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const stmt = this.db.prepare(sql).bind(...params);
    const result = await stmt.all<Record<string, unknown>>();
    return result.results ?? [];
  }

  async run(sql: string, params: unknown[]): Promise<void> {
    await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void> {
    if (statements.length === 0) return;
    const prepared = statements.map((s) => this.db.prepare(s.sql).bind(...s.params));
    await this.db.batch(prepared);
  }

  // No `transaction` — D1 has no interactive transactions.
}

async function ensureSchema(db: D1Database, table: string): Promise<void> {
  const statements = buildSchemaStatements(table);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
}

export function createD1GraphClient(
  db: D1Database,
  options: D1ClientOptions & { registryMode: DynamicRegistryConfig },
): Promise<DynamicGraphClient>;
export function createD1GraphClient(
  db: D1Database,
  options?: D1ClientOptions,
): Promise<GraphClient>;
export async function createD1GraphClient(
  db: D1Database,
  options: D1ClientOptions = {},
): Promise<GraphClient | DynamicGraphClient> {
  const table = options.table ?? 'firegraph';
  validateTableName(table);
  if (options.autoMigrate !== false) {
    await ensureSchema(db, table);
  }

  const executor = new D1Executor(db);
  const backend = createSqliteBackend(executor, table);

  const { table: _t, autoMigrate: _m, ...clientOptions } = options;
  void _t;
  void _m;

  // If a separate meta-collection is requested, create a second backend for it.
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
      await ensureSchema(db, metaTable);
    }
    metaBackend = createSqliteBackend(executor, metaTable);
  }

  return createGraphClientFromBackend(backend, clientOptions, metaBackend);
}
