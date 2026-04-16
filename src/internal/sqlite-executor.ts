/**
 * Driver-level SQLite abstraction.
 *
 * Two flavors of SQLite are supported:
 *  - Cloudflare D1 (`createD1Backend`) — async API, atomic batches via
 *    `db.batch()`, no interactive transactions.
 *  - Cloudflare Durable Object SQLite (`createDOSqliteBackend`) — sync API
 *    surfaced as async; supports both atomic batches and interactive
 *    transactions via `transactionSync`.
 *
 * The `SqliteBackend` only depends on this interface, not on either driver.
 */

export interface SqliteExecutor {
  /** Run a query and return all rows. */
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;

  /** Run a write statement. */
  run(sql: string, params: unknown[]): Promise<void>;

  /**
   * Execute a list of write statements atomically. Drivers that lack
   * native batch support (e.g., a wrapped synchronous SQLite) should still
   * implement this so `BatchBackend.commit()` works.
   */
  batch(statements: ReadonlyArray<{ sql: string; params: unknown[] }>): Promise<void>;

  /**
   * Run an interactive transaction. Optional — if absent, the SqliteBackend
   * throws on `runTransaction()`. D1 has no interactive transactions.
   */
  transaction?<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T>;

  /**
   * Maximum statements the driver will accept in a single `batch()` call.
   * The backend uses this to chunk large bulk operations (cascade delete,
   * bulkRemoveEdges) so a hub node with thousands of edges doesn't trip the
   * driver's hard limit. D1 caps at ~100 statements per batch; DO SQLite has
   * no documented cap (a single `transactionSync` over many statements is
   * fine). When `undefined`, the backend submits all statements in one batch
   * (preserving cross-batch atomicity for drivers that support it).
   */
  readonly maxBatchSize?: number;

  /**
   * Maximum total bound parameters the driver will accept across one
   * `batch()` call. D1 caps at ~1000 bound parameters per batch — separate
   * from `maxBatchSize`. Most cascade/bulk batches consist of 2-param
   * `DELETE` statements so this rarely triggers, but driver authors should
   * declare it for safety. When `undefined`, the backend doesn't split on
   * parameter count.
   */
  readonly maxBatchParams?: number;
}

export interface SqliteTxExecutor {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
}
