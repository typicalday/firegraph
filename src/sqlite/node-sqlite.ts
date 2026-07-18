/**
 * Local SQLite backend over Node.js built-in `node:sqlite` (`DatabaseSync`).
 *
 * This entry point is published as `firegraph/sqlite-builtin` and is the only
 * module in the library that references `node:sqlite`. Unlike `firegraph/sqlite-local`
 * (which uses optional-peer `better-sqlite3` loaded via dynamic `import()`), this
 * backend imports `DatabaseSync` statically — no native ABI compilation required.
 *
 * Requires **Node >= 22.5** where `node:sqlite` is available as a stable built-in.
 *
 * The factory accepts either a database file path (`':memory:'` works) or an
 * already-open `DatabaseSync` instance. Path-opened databases get
 * `journal_mode = WAL` and a `busy_timeout` applied; caller-provided
 * databases are used as-is (only `busy_timeout` is set) since the caller
 * owns their pragma configuration.
 *
 * ## Differences from `firegraph/sqlite-local` (better-sqlite3)
 *
 * Three non-mechanical API differences from `src/sqlite/local.ts`:
 *   (a) Pragma application: `db.exec('PRAGMA x = y')` instead of `db.pragma()`.
 *   (b) `batch()` uses manual `BEGIN/COMMIT/ROLLBACK` — `node:sqlite` has no
 *       `db.transaction()` wrapper.
 *   (c) UDF registration: `db.function(name, {deterministic:true}, fn)` — identical
 *       to `better-sqlite3`, ports 1:1.
 *
 * ## Search capabilities
 *
 * Identical to the local better-sqlite3 backend: `search.fullText` (FTS5 + triggers)
 * and `search.vector` (brute-force connection-local UDF scan). See
 * `src/internal/sqlite-search.ts` for the mechanics.
 */

import { existsSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { DatabaseSync } from 'node:sqlite';

import { FiregraphError } from '../errors.js';
import type { StorageBackend } from '../internal/backend.js';
import { createCapabilities } from '../internal/backend.js';
import type { SqliteExecutor, SqliteTxExecutor } from '../internal/sqlite-executor.js';
import { quoteIdent, validateTableName } from '../internal/sqlite-schema.js';
import type { DeclaredVector } from '../internal/sqlite-search.js';
import {
  buildLocalSearchDDL,
  buildVectorNullOnChangeTrigger,
  collectVectorDeclarations,
  compileFindNearest,
  compileFullTextSearch,
  computeVectorDistance,
  computeVectorDistanceBlob,
  DISTANCE_ALIAS,
  encodeVectorBlob,
  findOrphanedFtsTables,
  ftsMapTableName,
  ftsTableName,
  isFts5QueryError,
  isReadonlyWriteError,
  setDataPath,
  VECTOR_DISTANCE_BLOB_UDF,
  VECTOR_DISTANCE_UDF,
  vectorAddColumnSql,
  vectorBackfillSelectSql,
  vectorBackfillUpdateSql,
  vectorShadowColumn,
} from '../internal/sqlite-search.js';
import { rowToRecord } from '../internal/sqlite-sql.js';
import type { FindNearestParams, FullTextSearchParams, StoredGraphRecord } from '../types.js';
import type { SqliteBackendOptions, SqliteCapability, SqliteStorageBackend } from './backend.js';
import { createSqliteBackend } from './backend.js';
import { catalogTableName } from './catalog.js';

/**
 * Capability union for the node:sqlite backend: everything the shared SQLite
 * edition declares, plus native FTS5 full-text search and brute-force vector
 * search. Parallel to `LocalSqliteCapability` in `src/sqlite/local.ts`.
 */
export type LocalNodeSqliteCapability = SqliteCapability | 'search.fullText' | 'search.vector';

export interface NodeSqliteBackendOptions extends SqliteBackendOptions {
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

export interface NodeSqliteBackend {
  /** The graph storage backend — pass to `createGraphClient`. */
  backend: StorageBackend<LocalNodeSqliteCapability>;
  /** The underlying DatabaseSync instance, for raw access. */
  db: DatabaseSync;
  /**
   * Close the database. No-op when the factory was given an already-open
   * DatabaseSync (the caller owns its lifecycle).
   */
  close(): void;
}

/**
 * Build a transaction-capable `SqliteExecutor` over a `DatabaseSync` instance.
 * Interactive transactions use manual `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`
 * because `node:sqlite` has no `db.transaction()` wrapper.
 * `batch()` uses `BEGIN/COMMIT/ROLLBACK` for the same reason.
 *
 * Exported for callers that want to wire `createSqliteBackend` directly
 * (e.g. to share one executor across several root tables).
 */
export function createNodeSqliteExecutor(db: DatabaseSync): SqliteExecutor {
  return {
    async all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    },
    async run(sql: string, params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as SQLInputValue[]));
    },
    async batch(statements): Promise<void> {
      // node:sqlite has no db.transaction() helper — use manual BEGIN/COMMIT/ROLLBACK.
      db.exec('BEGIN');
      try {
        for (const s of statements) {
          db.prepare(s.sql).run(...(s.params as SQLInputValue[]));
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async transaction<T>(fn: (tx: SqliteTxExecutor) => Promise<T>): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn({
          async all(sql: string, params: unknown[]) {
            return db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
          },
          async run(sql: string, params: unknown[]) {
            db.prepare(sql).run(...(params as SQLInputValue[]));
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

function isDatabase(value: unknown): value is DatabaseSync {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { exec?: unknown }).exec === 'function'
  );
}

const PRAGMA_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Pragma values are identifiers (WAL, NORMAL) or integers — never compound
// expressions, so anything else is rejected rather than interpolated.
const PRAGMA_VALUE_PATTERN = /^-?[A-Za-z0-9_]+$/;

function applyPragmas(db: DatabaseSync, pragmas: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(pragmas)) {
    if (!PRAGMA_KEY_PATTERN.test(key)) {
      throw new FiregraphError(`Invalid pragma name: ${JSON.stringify(key)}`, 'INVALID_ARGUMENT');
    }
    if (
      !PRAGMA_VALUE_PATTERN.test(String(value)) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new FiregraphError(
        `Invalid pragma value for ${key}: ${JSON.stringify(value)}`,
        'INVALID_ARGUMENT',
      );
    }
    // node:sqlite has no db.pragma() helper — use db.exec() instead.
    db.exec(`PRAGMA ${key} = ${value}`);
  }
}

/**
 * Register the vector-distance UDF on a connection. Idempotent across
 * multiple factory calls over the same caller-provided DatabaseSync —
 * re-registering the identical pure function changes nothing; swallow errors.
 */
function registerVectorUdf(db: DatabaseSync): void {
  try {
    db.function(VECTOR_DISTANCE_UDF, { deterministic: true }, (stored, query, measure) =>
      computeVectorDistance(stored, query, measure),
    );
  } catch {
    // Already registered on this connection.
  }
  try {
    db.function(VECTOR_DISTANCE_BLOB_UDF, { deterministic: true }, (blob, query, measure) =>
      computeVectorDistanceBlob(blob, query, measure),
    );
  } catch {
    // Already registered on this connection.
  }
}

/**
 * After a cascade DROPs descendant graph tables, their FTS artifacts
 * (`<t>_fts`, `<t>_fts_map`) survive — triggers die with the base table
 * but separate tables do not. Sweep and drop any artifact whose base
 * graph table is gone.
 */
async function sweepOrphanedFtsArtifacts(
  executor: SqliteExecutor,
  rootTable: string,
): Promise<void> {
  const tableRows = await executor.all(
    `SELECT "name" FROM sqlite_master WHERE "type" = 'table'`,
    [],
  );
  const allTables = tableRows.map((r) => String(r.name));
  const catalogRows = await executor.all(
    `SELECT "table_name" FROM ${quoteIdent(catalogTableName(rootTable))}`,
    [],
  );
  const catalogTables = catalogRows.map((r) => String(r.table_name));
  for (const name of findOrphanedFtsTables(allTables, catalogTables, rootTable)) {
    validateTableName(name);
    await executor.run(`DROP TABLE IF EXISTS ${quoteIdent(name)}`, []);
  }
}

/**
 * Wrap the shared SQLite backend with the two search capabilities. Every
 * core method delegates to the inner backend unchanged; `subgraph()`
 * re-wraps so children search too, and `removeNodeCascade` follows the
 * inner cascade with the orphaned-FTS sweep.
 */
function wrapLocalSearchBackend(
  inner: SqliteStorageBackend,
  executor: SqliteExecutor,
  rootTable: string,
  vectorDecls: ReadonlyArray<{ field: string; dimension: number }>,
): StorageBackend<LocalNodeSqliteCapability> {
  const caps = new Set<LocalNodeSqliteCapability>([
    ...(inner.capabilities.values() as IterableIterator<SqliteCapability>),
    'search.fullText',
    'search.vector',
  ]);

  const healableTables = new Set([
    inner.collectionPath,
    ftsTableName(inner.collectionPath),
    ftsMapTableName(inner.collectionPath),
  ]);
  const runWithSchema = async <T>(op: () => Promise<T>): Promise<T> => {
    await inner.ensureReady();
    try {
      return await op();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missing = /no such table: (\S+)/.exec(message)?.[1];
      if (missing === undefined || !healableTables.has(missing)) throw err;
      await inner.ensureReady(true);
      return op();
    }
  };

  // Lazy JS ensure of the declared vector shadow columns for THIS resolved
  // table, cached on the wrapper instance (like SqliteBackendImpl.ensured).
  // Returns only the declared vectors whose Float64 LE BLOB shadow column
  // PROVABLY EXISTS on this handle — exactly what compileFindNearest may
  // reference in SQL. Reset to null by the findNearest self-heal so a
  // cascade-recreated table re-materializes the column/trigger/backfill.
  let vecEnsured: Promise<DeclaredVector[]> | null = null;

  // Parse + validate + encode the rows still missing a blob, then bind the
  // BLOB as a parameter. Dimension validation lives HERE (refinement 1/4): a
  // wrong-length or non-numeric vector is skipped, leaving the shadow column
  // NULL, so at query time its row hits the JSON branch and drops out.
  const backfillVectorColumn = async (
    table: string,
    decl: { field: string; dimension: number },
  ): Promise<void> => {
    const rows = await executor.all(vectorBackfillSelectSql(table, decl.field), []);
    if (rows.length === 0) return;
    const updateSql = vectorBackfillUpdateSql(table, decl.field);
    const updates: { sql: string; params: unknown[] }[] = [];
    for (const row of rows) {
      const raw = row.v;
      // json_extract of a stored array returns its JSON text; anything else
      // (scalar, object) is not a vector — skip it.
      if (typeof raw !== 'string') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed) || parsed.length !== decl.dimension) continue;
      let ok = true;
      for (const n of parsed) {
        if (typeof n !== 'number' || !Number.isFinite(n)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      updates.push({
        sql: updateSql,
        params: [encodeVectorBlob(parsed as number[]), String(row.doc_id)],
      });
    }
    if (updates.length > 0) await executor.batch(updates);
  };

  // `inner.ensureReady()` bootstraps the base schema — table DDL plus a
  // catalog-register INSERT and any FTS reconciliation. Those are WRITES, so on
  // a read-only handle the bootstrap throws before findNearest can read. But a
  // read-only DB's schema was necessarily created while it was writable, so we
  // tolerate the read-only write failure and query what's already there; any
  // other bootstrap error still propagates.
  const ensureReadyTolerant = async (force = false): Promise<void> => {
    try {
      await inner.ensureReady(force);
    } catch (err) {
      if (!isReadonlyWriteError(err)) throw err;
    }
  };

  const doVecEnsure = async (): Promise<DeclaredVector[]> => {
    if (vectorDecls.length === 0) return [];
    await ensureReadyTolerant();
    const table = inner.collectionPath;
    let existingCols: Set<string>;
    try {
      const info = await executor.all(`PRAGMA table_info(${quoteIdent(table)})`, []);
      existingCols = new Set(info.map((r) => String(r.name)));
    } catch {
      // Can't even read the schema — no blob path; reads use pure JSON.
      return [];
    }
    const materialized: DeclaredVector[] = [];
    for (const decl of vectorDecls) {
      const shadowColumn = vectorShadowColumn(decl.field);
      let columnExists = existingCols.has(shadowColumn);
      if (!columnExists) {
        try {
          // The ALTER is the one non-idempotent statement — run it OUTSIDE the
          // chunked extraTableDDL transaction, guarded by the table_info check.
          await executor.run(vectorAddColumnSql(table, decl.field), []);
          columnExists = true;
        } catch (err) {
          // A lost race (a concurrent connection added it first) surfaces as
          // "duplicate column name" — treat the column as present. Any other
          // write failure (read-only DB) leaves it unmaterialized, so
          // compileFindNearest never references a missing column.
          const msg = err instanceof Error ? err.message : String(err);
          columnExists = /duplicate column name/i.test(msg);
        }
      }
      if (!columnExists) continue;
      // Column exists → usable for reads even on a read-only handle.
      materialized.push({ field: decl.field, dimension: decl.dimension, shadowColumn });
      // Best-effort trigger + backfill. On a read-only DB these writes throw;
      // swallow and let the CASE fall back to the JSON branch for NULL blobs.
      try {
        await executor.run(buildVectorNullOnChangeTrigger(table, decl.field), []);
        await backfillVectorColumn(table, decl);
      } catch {
        // read-only or transient write failure — reads stay correct.
      }
    }
    return materialized;
  };
  const runVecEnsure = (): Promise<DeclaredVector[]> => (vecEnsured ??= doVecEnsure());

  const wrapper: StorageBackend<LocalNodeSqliteCapability> = {
    capabilities: createCapabilities(caps),
    collectionPath: inner.collectionPath,
    scopePath: inner.scopePath,

    getDoc: (docId) => inner.getDoc(docId),
    query: (filters, options) => inner.query(filters, options),
    setDoc: (docId, record, mode) => inner.setDoc(docId, record, mode),
    updateDoc: (docId, update) => inner.updateDoc(docId, update),
    deleteDoc: (docId) => inner.deleteDoc(docId),
    runTransaction: (fn) => inner.runTransaction(fn),
    createBatch: () => inner.createBatch(),

    subgraph: (parentNodeUid, name) =>
      wrapLocalSearchBackend(inner.subgraph(parentNodeUid, name), executor, rootTable, vectorDecls),

    removeNodeCascade: async (uid, reader, options) => {
      const result = await inner.removeNodeCascade(uid, reader, options);
      if (result.errors.length === 0) {
        await sweepOrphanedFtsArtifacts(executor, rootTable);
      }
      return result;
    },
    bulkRemoveEdges: (params, reader, options) => inner.bulkRemoveEdges(params, reader, options),

    aggregate: (spec, filters) => inner.aggregate!(spec, filters),
    bulkDelete: (filters, options) => inner.bulkDelete!(filters, options),
    bulkUpdate: (filters, patch, options) => inner.bulkUpdate!(filters, patch, options),
    expand: (params) => inner.expand!(params),
    findEdgesProjected: (select, filters, options) =>
      inner.findEdgesProjected!(select, filters, options),

    // `findEdgesGlobal` stays absent — same as the inner backend.

    async findNearest(params: FindNearestParams): Promise<StoredGraphRecord[]> {
      const run = async (): Promise<{
        rows: Record<string, unknown>[];
        distancePath: string[] | null;
      }> => {
        // Ensure the base table (covers the no-declaration case, where
        // runVecEnsure short-circuits without bootstrapping), then materialize
        // shadow columns BEFORE compiling so the SQL only references a column
        // that provably exists. `ensureReadyTolerant` lets a read-only handle
        // fall through to the pure-JSON branch instead of throwing on the
        // bootstrap's catalog write.
        await ensureReadyTolerant();
        const materialized = await runVecEnsure();
        const { stmt, distancePath } = compileFindNearest(
          inner.collectionPath,
          params,
          materialized,
        );
        const rows = await executor.all(stmt.sql, stmt.params);
        return { rows, distancePath };
      };
      const toRecords = (result: {
        rows: Record<string, unknown>[];
        distancePath: string[] | null;
      }): StoredGraphRecord[] =>
        result.rows.map((row) => {
          const record = rowToRecord(row);
          if (result.distancePath) {
            const distance = row[DISTANCE_ALIAS];
            setDataPath(
              record.data as Record<string, unknown>,
              result.distancePath,
              typeof distance === 'number' ? distance : Number(distance),
            );
          }
          return record;
        });
      try {
        return toRecords(await run());
      } catch (err) {
        // Same self-heal as runWithSchema, plus a shadow-column cache reset:
        // after a parent cascade drops+recreates the table the shadow column
        // and trigger are gone, so a "no such table" (or a stale
        // "no such column: __vec…") must re-materialize against the reborn
        // table before the single retry.
        const message = err instanceof Error ? err.message : String(err);
        const missing = /no such table: (\S+)/.exec(message)?.[1];
        const missingVecCol = /no such column: "?__vec_/.test(message);
        if ((missing === undefined || !healableTables.has(missing)) && !missingVecCol) {
          throw err;
        }
        await inner.ensureReady(true);
        vecEnsured = null;
        return toRecords(await run());
      }
    },

    async fullTextSearch(params: FullTextSearchParams): Promise<StoredGraphRecord[]> {
      const stmt = compileFullTextSearch(inner.collectionPath, params);
      let rows: Record<string, unknown>[];
      try {
        rows = await runWithSchema(() => executor.all(stmt.sql, stmt.params));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isFts5QueryError(message)) {
          throw new FiregraphError(
            `fullTextSearch(): invalid FTS5 query syntax — ${message}`,
            'INVALID_QUERY',
          );
        }
        throw err;
      }
      return rows.map(rowToRecord);
    },
  };
  return wrapper;
}

/**
 * Open (or wrap) a local SQLite database using Node.js built-in `node:sqlite`
 * and return a graph storage backend over it.
 *
 * ```typescript
 * import { createNodeSqliteBackend } from 'firegraph/sqlite-builtin';
 * import { createGraphClient } from 'firegraph/sqlite';
 *
 * const { backend, close } = await createNodeSqliteBackend('./graph.db');
 * const client = createGraphClient(backend);
 * // ... use the client — including fullTextSearch() and findNearest() ...
 * close();
 * ```
 *
 * Requires Node >= 22.5 (where `node:sqlite` is available as a stable built-in).
 * No `better-sqlite3` or any other native dependency needed.
 */
export async function createNodeSqliteBackend(
  pathOrDb: string | DatabaseSync,
  options: NodeSqliteBackendOptions = {},
): Promise<NodeSqliteBackend> {
  const {
    tableName = 'firegraph',
    busyTimeoutMs = 5000,
    pragmas,
    fileMustExist,
    ...backendOptions
  } = options;

  let db: DatabaseSync;
  let ownsDb: boolean;
  if (typeof pathOrDb === 'string') {
    if (fileMustExist && !existsSync(pathOrDb)) {
      throw new FiregraphError(
        `createNodeSqliteBackend: file does not exist: ${pathOrDb}`,
        'INVALID_ARGUMENT',
      );
    }
    db = new DatabaseSync(pathOrDb);
    ownsDb = true;
    // WAL lets concurrent readers coexist with a writer — the right default
    // for a long-lived local graph file. On ':memory:' databases SQLite
    // reports 'memory' and ignores the request, which is fine.
    // node:sqlite has no db.pragma() helper — use db.exec() instead.
    db.exec('PRAGMA journal_mode = WAL');
  } else if (isDatabase(pathOrDb)) {
    db = pathOrDb;
    ownsDb = false;
  } else {
    throw new FiregraphError(
      'createNodeSqliteBackend expects a file path or an open DatabaseSync',
      'INVALID_ARGUMENT',
    );
  }

  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  if (pragmas) {
    applyPragmas(db, pragmas);
  }
  registerVectorUdf(db);

  // Compose the FTS DDL into the lazy bootstrap so every graph table —
  // root, lazily created subgraphs, and self-heal recreations — gets its
  // FTS infrastructure the moment the table exists.
  const userExtraDDL = backendOptions.extraTableDDL;
  const optionsWithSearch: SqliteBackendOptions = {
    ...backendOptions,
    extraTableDDL: (table) => [
      ...(userExtraDDL ? userExtraDDL(table) : []),
      ...buildLocalSearchDDL(table),
    ],
  };

  // Collect DECLARED vector fields once at factory time; a misconfigured
  // registry (conflicting dimensions for one field) fails fast here.
  const vectorDecls = collectVectorDeclarations(backendOptions.registry);

  const executor = createNodeSqliteExecutor(db);
  const inner = createSqliteBackend(executor, tableName, optionsWithSearch);
  const backend = wrapLocalSearchBackend(inner, executor, tableName, vectorDecls);
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
