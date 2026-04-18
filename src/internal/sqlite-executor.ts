/**
 * Driver-level SQLite abstraction.
 *
 * The `SqliteBackend` only depends on this interface, not on any particular
 * SQLite driver. Callers wire up whichever driver suits their runtime —
 * `better-sqlite3` in Node tests, D1 in Workers, DO SQLite inside a Durable
 * Object, etc. — and `createSqliteBackend` composes the rest.
 *
 * Some drivers are fully async with native atomic batches (e.g. D1); others
 * are synchronous and wrap `run`/`all` in immediately-resolved promises while
 * providing interactive transactions via a sync primitive (e.g. DO SQLite's
 * `transactionSync`). Both shapes fit behind this interface.
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
