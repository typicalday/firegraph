/**
 * SQLite implementation of `StorageBackend`.
 *
 * Uses a single table keyed by `(scope, doc_id)`. Subgraphs are encoded in
 * the `scope` column as a materialized path of interleaved parent UIDs and
 * subgraph names — `''` at the root, `'<uid>/<name>'` one level down,
 * `'<uid1>/<name1>/<uid2>/<name2>'` two levels down, and so on. Cascade
 * delete uses a single `DELETE … WHERE scope LIKE 'prefix/%'` instead of
 * walking subcollections.
 */

import { computeEdgeDocId, computeNodeDocId } from '../docid.js';
import { FiregraphError } from '../errors.js';
import type {
  BackendCapabilities,
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from '../internal/backend.js';
import { createCapabilities } from '../internal/backend.js';
import { NODE_RELATION } from '../internal/constants.js';
import type { SqliteExecutor, SqliteTxExecutor } from '../internal/sqlite-executor.js';
import { buildEdgeQueryPlan } from '../query.js';
import type {
  AggregateSpec,
  BulkBatchError,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  CascadeResult,
  ExpandParams,
  ExpandResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';
import type { CompiledStatement } from './sql.js';
import {
  compileAggregate,
  compileBulkDelete,
  compileBulkUpdate,
  compileCountScopePrefix,
  compileDelete,
  compileDeleteScopePrefix,
  compileExpand,
  compileExpandHydrate,
  compileFindEdgesProjected,
  compileSelect,
  compileSelectByDocId,
  compileSelectGlobal,
  compileSet,
  compileUpdate,
  decodeProjectedRow,
  rowToRecord,
} from './sql.js';

export interface SqliteBackendOptions {
  /** Logical scope path (chained subgraph names) — used for `allowedIn` matching. */
  scopePath?: string;
  /** Internal storage scope (interleaved parent-uid/name path). */
  storageScope?: string;
}

/**
 * Default per-chunk retry budget for bulk/cascade operations. Mirrors the
 * Firestore bulk path (`src/bulk.ts`) so behaviour is consistent across
 * backends. Callers override via `BulkOptions.maxRetries`.
 */
const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 200;
/**
 * Upper bound for the exponential backoff between chunk retries. Without
 * this cap, `maxRetries: 10` would push the final wait past 100s; legitimate
 * transient errors recover well within a few seconds, and longer waits just
 * delay the surfacing of permanent failures.
 */
const MAX_RETRY_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return the smaller of two optional positive numbers, treating `undefined`
 * as "no cap." Used to combine caller-supplied `BulkOptions.batchSize` with
 * the driver's own `maxBatchSize` so the more restrictive cap wins.
 */
function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Split `statements` into chunks that respect both a per-batch statement
 * count cap (`maxStatements`) and a per-batch total bound-parameter cap
 * (`maxParams`). When neither cap is provided the entire list is returned
 * as a single chunk (preserves cross-batch atomicity for drivers like
 * DO SQLite that have no caps).
 *
 * Single-statement edge case: if a single statement's parameter count
 * already exceeds `maxParams`, it's emitted as its own chunk anyway. The
 * driver will reject it, which is the correct behavior — silently
 * dropping it would be worse.
 */
function chunkStatements<T extends { params: unknown[] }>(
  statements: T[],
  maxStatements: number | undefined,
  maxParams: number | undefined,
): T[][] {
  const stmtCap =
    maxStatements && maxStatements > 0 && Number.isFinite(maxStatements)
      ? Math.floor(maxStatements)
      : Infinity;
  const paramCap =
    maxParams && maxParams > 0 && Number.isFinite(maxParams) ? Math.floor(maxParams) : Infinity;

  if (stmtCap === Infinity && paramCap === Infinity) {
    return [statements];
  }

  const chunks: T[][] = [];
  let current: T[] = [];
  let currentParamCount = 0;
  for (const stmt of statements) {
    const stmtParams = stmt.params.length;
    const wouldExceedStmt = current.length + 1 > stmtCap;
    const wouldExceedParam = currentParamCount + stmtParams > paramCap;
    if (current.length > 0 && (wouldExceedStmt || wouldExceedParam)) {
      chunks.push(current);
      current = [];
      currentParamCount = 0;
    }
    current.push(stmt);
    currentParamCount += stmtParams;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

class SqliteTransactionBackendImpl implements TransactionBackend {
  constructor(
    private readonly tx: SqliteTxExecutor,
    private readonly tableName: string,
    private readonly storageScope: string,
  ) {}

  async getDoc(docId: string): Promise<StoredGraphRecord | null> {
    const stmt = compileSelectByDocId(this.tableName, this.storageScope, docId);
    const rows = await this.tx.all(stmt.sql, stmt.params);
    return rows.length === 0 ? null : rowToRecord(rows[0]);
  }

  async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    const stmt = compileSelect(this.tableName, this.storageScope, filters, options);
    const rows = await this.tx.all(stmt.sql, stmt.params);
    return rows.map(rowToRecord);
  }

  async setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    const stmt = compileSet(this.tableName, this.storageScope, docId, record, Date.now(), mode);
    await this.tx.run(stmt.sql, stmt.params);
  }

  async updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    const stmt = compileUpdate(this.tableName, this.storageScope, docId, update, Date.now());
    // RETURNING + `all()` for parity with Firestore — see SqliteBackendImpl.updateDoc.
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    const rows = await this.tx.all(sqlWithReturning, stmt.params);
    if (rows.length === 0) {
      throw new FiregraphError(
        `updateDoc: no document found for doc_id=${docId} (scope=${this.storageScope})`,
        'NOT_FOUND',
      );
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    const stmt = compileDelete(this.tableName, this.storageScope, docId);
    await this.tx.run(stmt.sql, stmt.params);
  }
}

class SqliteBatchBackendImpl implements BatchBackend {
  private readonly statements: CompiledStatement[] = [];

  constructor(
    private readonly executor: SqliteExecutor,
    private readonly tableName: string,
    private readonly storageScope: string,
  ) {}

  setDoc(docId: string, record: WritableRecord, mode: WriteMode): void {
    this.statements.push(
      compileSet(this.tableName, this.storageScope, docId, record, Date.now(), mode),
    );
  }

  updateDoc(docId: string, update: UpdatePayload): void {
    this.statements.push(
      compileUpdate(this.tableName, this.storageScope, docId, update, Date.now()),
    );
  }

  deleteDoc(docId: string): void {
    this.statements.push(compileDelete(this.tableName, this.storageScope, docId));
  }

  async commit(): Promise<void> {
    if (this.statements.length === 0) return;
    await this.executor.batch(this.statements);
    this.statements.length = 0;
  }
}

/**
 * Capability union declared by the SQLite-backed `StorageBackend`.
 *
 * `core.transactions` is part of the static union because `runTransaction`
 * is always present as a method on the class. The runtime cap-set determines
 * whether that method is *functional*: D1 leaves `executor.transaction`
 * undefined and the call throws `UNSUPPORTED_OPERATION`; DO SQLite and
 * better-sqlite3 wire the executor and the call works. The static type
 * therefore promises only that the method exists — callers that care about
 * portability check `client.capabilities.has('core.transactions')` before
 * opening a tx, and code that runs against an unknown driver can rely on the
 * runtime guard inside `runTransaction`.
 *
 * The `query.*` extension capabilities follow the same conservative
 * declaration rule as the cap descriptor itself — only land in the union
 * when the corresponding method is actually wired up. Today that's
 * `query.aggregate` (Phase 4), `query.dml` (Phase 5), `query.join`
 * (Phase 6 — fan-out via `IN (…)` in one statement), and `query.select`
 * (Phase 7 — server-side projection via `json_extract`).
 */
export type SqliteCapability =
  | 'core.read'
  | 'core.write'
  | 'core.transactions'
  | 'core.batch'
  | 'core.subgraph'
  | 'query.aggregate'
  | 'query.dml'
  | 'query.join'
  | 'query.select'
  | 'raw.sql';

const SQLITE_CORE_CAPS: ReadonlyArray<SqliteCapability> = [
  'core.read',
  'core.write',
  'core.batch',
  'core.subgraph',
  'query.aggregate',
  'query.dml',
  'query.join',
  'query.select',
  'raw.sql',
];

class SqliteBackendImpl implements StorageBackend<SqliteCapability> {
  readonly capabilities: BackendCapabilities<SqliteCapability>;
  /** Logical table name (returned through `collectionPath` for parity with Firestore). */
  readonly collectionPath: string;
  readonly scopePath: string;
  /** Materialized storage scope (interleaved parent UIDs + subgraph names). */
  private readonly storageScope: string;

  constructor(
    private readonly executor: SqliteExecutor,
    tableName: string,
    storageScope: string,
    scopePath: string,
  ) {
    this.collectionPath = tableName;
    this.storageScope = storageScope;
    this.scopePath = scopePath;
    const caps = new Set<SqliteCapability>(SQLITE_CORE_CAPS);
    if (typeof executor.transaction === 'function') {
      caps.add('core.transactions');
    }
    this.capabilities = createCapabilities(caps);
  }

  // --- Reads ---

  async getDoc(docId: string): Promise<StoredGraphRecord | null> {
    const stmt = compileSelectByDocId(this.collectionPath, this.storageScope, docId);
    const rows = await this.executor.all(stmt.sql, stmt.params);
    return rows.length === 0 ? null : rowToRecord(rows[0]);
  }

  async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    const stmt = compileSelect(this.collectionPath, this.storageScope, filters, options);
    const rows = await this.executor.all(stmt.sql, stmt.params);
    return rows.map(rowToRecord);
  }

  // --- Writes ---

  async setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    const stmt = compileSet(
      this.collectionPath,
      this.storageScope,
      docId,
      record,
      Date.now(),
      mode,
    );
    await this.executor.run(stmt.sql, stmt.params);
  }

  async updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    const stmt = compileUpdate(this.collectionPath, this.storageScope, docId, update, Date.now());
    // Use RETURNING + `all()` so missing rows surface as an error, matching
    // Firestore's `update()` semantics (NOT_FOUND when the doc doesn't exist).
    // SQLite ≥3.35 supports UPDATE … RETURNING; better-sqlite3, D1, and DO
    // SQLite all run on a recent enough engine.
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    const rows = await this.executor.all(sqlWithReturning, stmt.params);
    if (rows.length === 0) {
      throw new FiregraphError(
        `updateDoc: no document found for doc_id=${docId} (scope=${this.storageScope})`,
        'NOT_FOUND',
      );
    }
  }

  async deleteDoc(docId: string): Promise<void> {
    const stmt = compileDelete(this.collectionPath, this.storageScope, docId);
    await this.executor.run(stmt.sql, stmt.params);
  }

  // --- Transactions / Batches ---

  async runTransaction<T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
    if (!this.executor.transaction) {
      throw new FiregraphError(
        'Interactive transactions are not supported by this SQLite driver. ' +
          'D1 in particular has no read-then-conditional-write transactions; ' +
          'use a Durable Object SQLite client instead, or rewrite the code path ' +
          'as a batch().',
        'UNSUPPORTED_OPERATION',
      );
    }
    return this.executor.transaction(async (tx) => {
      const txBackend = new SqliteTransactionBackendImpl(
        tx,
        this.collectionPath,
        this.storageScope,
      );
      return fn(txBackend);
    });
  }

  createBatch(): BatchBackend {
    return new SqliteBatchBackendImpl(this.executor, this.collectionPath, this.storageScope);
  }

  // --- Subgraphs ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    // Defense-in-depth: the public `GraphClient.subgraph()` also validates,
    // but backend users (traversal, cross-graph hops, custom integrations)
    // reach this method directly. A bad UID or a name containing '/' would
    // corrupt the materialized-path scope encoding — reject loudly.
    if (!parentNodeUid || parentNodeUid.includes('/')) {
      throw new FiregraphError(
        `Invalid parentNodeUid for subgraph: "${parentNodeUid}". ` +
          'Must be a non-empty string without "/".',
        'INVALID_SUBGRAPH',
      );
    }
    if (!name || name.includes('/')) {
      throw new FiregraphError(
        `Subgraph name must not contain "/" and must be non-empty: got "${name}". ` +
          'Use chained .subgraph() calls for nested subgraphs.',
        'INVALID_SUBGRAPH',
      );
    }
    const newStorageScope = this.storageScope
      ? `${this.storageScope}/${parentNodeUid}/${name}`
      : `${parentNodeUid}/${name}`;
    const newScope = this.scopePath ? `${this.scopePath}/${name}` : name;
    return new SqliteBackendImpl(this.executor, this.collectionPath, newStorageScope, newScope);
  }

  // --- Cascade & bulk ---

  async removeNodeCascade(
    uid: string,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<CascadeResult> {
    // Collect all edges touching the node in the current scope (excluding self-loop).
    const [outgoingRaw, incomingRaw] = await Promise.all([
      reader.findEdges({ aUid: uid, allowCollectionScan: true, limit: 0 }),
      reader.findEdges({ bUid: uid, allowCollectionScan: true, limit: 0 }),
    ]);

    const seen = new Set<string>();
    const edgeDocIds: string[] = [];
    for (const edge of [...outgoingRaw, ...incomingRaw]) {
      if (edge.axbType === NODE_RELATION) continue;
      const docId = computeEdgeDocId(edge.aUid, edge.axbType, edge.bUid);
      if (!seen.has(docId)) {
        seen.add(docId);
        edgeDocIds.push(docId);
      }
    }

    const nodeDocId = computeNodeDocId(uid);
    const shouldDeleteSubgraphs = options?.deleteSubcollections !== false;

    // Pre-count subgraph rows so the returned `deleted` total reflects the
    // actual number of records removed by the prefix-delete (which is a
    // single statement, but may match many rows). One extra index lookup is
    // cheap relative to the cascade itself.
    let subgraphRowCount = 0;
    if (shouldDeleteSubgraphs) {
      const prefix = this.storageScope ? `${this.storageScope}/${uid}` : uid;
      const countStmt = compileCountScopePrefix(this.collectionPath, prefix);
      const countRows = await this.executor.all(countStmt.sql, countStmt.params);
      const first = countRows[0] as Record<string, unknown> | undefined;
      const n = first?.n;
      subgraphRowCount = typeof n === 'bigint' ? Number(n) : Number(n ?? 0);
    }

    // Build the full statement list. Order: edges → node → prefix-delete.
    // When the executor's `batch()` is fully atomic (DO SQLite uses
    // `transactionSync`) the chunking loop below collapses to a single batch
    // and the operation is atomic. When the executor caps batches (D1, ~100
    // statements) we lose cross-batch atomicity, but `removeNodeCascade` is
    // idempotent so a caller can retry after a partial failure.
    const writeStatements: CompiledStatement[] = edgeDocIds.map((id) =>
      compileDelete(this.collectionPath, this.storageScope, id),
    );
    writeStatements.push(compileDelete(this.collectionPath, this.storageScope, nodeDocId));
    if (shouldDeleteSubgraphs) {
      const prefix = this.storageScope ? `${this.storageScope}/${uid}` : uid;
      writeStatements.push(compileDeleteScopePrefix(this.collectionPath, prefix));
    }

    const {
      deleted: stmtDeleted,
      batches,
      errors,
    } = await this.executeChunkedBatches(writeStatements, options);

    // `nodeDeleted` / `edgesDeleted` reflect best-effort completion: a
    // chunk failure leaves us unable to know which sub-batch contained the
    // node-row delete, so we conservatively flag both as incomplete when
    // any batch fails. The caller can retry — cascade is idempotent.
    const allOk = errors.length === 0;
    const edgesDeleted = allOk ? edgeDocIds.length : 0;
    const nodeDeleted = allOk;

    // `stmtDeleted` counts committed *statements*. Replace the prefix-
    // delete's per-statement contribution (1) with the pre-computed row
    // count so callers see a true row total. Only credit subgraph rows when
    // every chunk succeeded — partial failure means we can't be sure the
    // chunk containing the prefix-delete actually committed.
    const prefixStatementContribution = shouldDeleteSubgraphs && allOk ? 1 : 0;
    const deleted = stmtDeleted - prefixStatementContribution + (allOk ? subgraphRowCount : 0);

    return { deleted, batches, errors, edgesDeleted, nodeDeleted };
  }

  async bulkRemoveEdges(
    params: FindEdgesParams,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    // Override default query limit for bulk deletion — we need all matching edges.
    // limit: 0 bypasses DEFAULT_QUERY_LIMIT; an explicit user limit is preserved.
    // allowCollectionScan: true — bulk deletion inherently implies scanning.
    const effectiveParams =
      params.limit !== undefined
        ? { ...params, allowCollectionScan: params.allowCollectionScan ?? true }
        : { ...params, limit: 0, allowCollectionScan: params.allowCollectionScan ?? true };
    const edges = await reader.findEdges(effectiveParams);
    const docIds = edges.map((e) => computeEdgeDocId(e.aUid, e.axbType, e.bUid));

    if (docIds.length === 0) {
      return { deleted: 0, batches: 0, errors: [] };
    }

    const statements = docIds.map((id) =>
      compileDelete(this.collectionPath, this.storageScope, id),
    );

    return this.executeChunkedBatches(statements, options);
  }

  /**
   * Submit `statements` to the executor as one or more `batch()` calls,
   * chunking by `executor.maxBatchSize` (e.g. D1's ~100-statement cap).
   * Drivers that don't advertise a cap submit everything in one batch,
   * preserving cross-batch atomicity.
   *
   * Each chunk is retried with exponential backoff up to `maxRetries`
   * (default 3) before being recorded in `errors`. The loop continues past
   * a permanently failed chunk so the caller still gets partial progress
   * visibility — to halt on first failure, set `maxRetries: 0` and check
   * `result.errors.length` after the call.
   *
   * Returns `BulkResult`-shaped fields. `deleted` reflects only the
   * statement count of *successfully committed* batches — a prefix-delete
   * statement contributes 1 to that total even though it may match many
   * rows; `removeNodeCascade` patches that up with a pre-counted row total.
   *
   * **Atomicity caveat (D1):** when chunking kicks in, atomicity is lost
   * across chunk boundaries — one chunk may commit while a later one fails.
   * `removeNodeCascade` is idempotent (deleting the same docs again is a
   * no-op) so a caller can simply retry on partial failure. `bulkRemoveEdges`
   * is also idempotent for the same reason. DO SQLite leaves `maxBatchSize`
   * unset, so everything funnels through one atomic `transactionSync` and
   * this caveat does not apply.
   */
  private async executeChunkedBatches(
    statements: CompiledStatement[],
    options?: BulkOptions,
  ): Promise<{ deleted: number; batches: number; errors: BulkBatchError[] }> {
    if (statements.length === 0) {
      return { deleted: 0, batches: 0, errors: [] };
    }
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Split `statements` into chunks up front. Chunking honors the smallest
    // of: caller-supplied `batchSize` (used by callers who want progress
    // granularity), the driver's statement-count cap (`maxBatchSize`, D1 ≈
    // 100), and the driver's total bound-parameter cap (`maxBatchParams`,
    // D1 ≈ 1000). Most cascade/bulk statements are 2-param DELETEs so the
    // param cap rarely triggers, but we respect it defensively. Drivers with
    // no declared caps and no caller cap submit everything in one batch (DO
    // SQLite's atomic `transactionSync`).
    const callerBatchSize = options?.batchSize;
    const stmtCap = minDefined(callerBatchSize, this.executor.maxBatchSize);
    const chunks = chunkStatements(statements, stmtCap, this.executor.maxBatchParams);

    const errors: BulkBatchError[] = [];
    let deleted = 0;
    let batches = 0;
    const totalBatches = chunks.length;

    const driverParamCap = this.executor.maxBatchParams;

    for (let batchIndex = 0; batchIndex < chunks.length; batchIndex++) {
      const chunk = chunks[batchIndex];

      // A chunk that's a single statement whose param count already exceeds
      // the driver's per-batch param cap will be rejected on every attempt —
      // retrying just adds latency before surfacing the failure. `chunkStatements`
      // intentionally emits such statements as their own chunk (failing loudly
      // beats silently dropping); fast-fail here closes the loop.
      const isUnretriableOversize =
        chunk.length === 1 &&
        driverParamCap !== undefined &&
        chunk[0].params.length > driverParamCap;

      let committed = false;
      let lastError: Error | null = null;
      const effectiveRetries = isUnretriableOversize ? 0 : maxRetries;
      for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
        try {
          await this.executor.batch(chunk);
          committed = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < effectiveRetries) {
            const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
            await sleep(delay);
          }
        }
      }

      if (committed) {
        deleted += chunk.length;
        batches += 1;
      } else if (lastError) {
        errors.push({
          batchIndex,
          error: lastError,
          operationCount: chunk.length,
        });
      }

      if (options?.onProgress) {
        options.onProgress({
          completedBatches: batches,
          totalBatches,
          deletedSoFar: deleted,
        });
      }
    }

    return { deleted, batches, errors };
  }

  // --- Cross-scope (collection group) ---

  async findEdgesGlobal(
    params: FindEdgesParams,
    collectionName?: string,
  ): Promise<StoredGraphRecord[]> {
    const plan = buildEdgeQueryPlan(params);
    if (plan.strategy === 'get') {
      throw new FiregraphError(
        'findEdgesGlobal() requires a query, not a direct document lookup. ' +
          'Omit one of aUid/axbType/bUid to force a query strategy.',
        'INVALID_QUERY',
      );
    }
    // Mirror Firestore's `collectionGroup(name)` semantics over the
    // materialized-scope SQLite layout: when `collectionName` matches the
    // table name (the implicit root default), filter to root rows; otherwise
    // filter to rows whose scope's last segment equals the requested name.
    const name = collectionName ?? this.collectionPath;
    const scopeNameFilter = {
      name,
      isRoot: name === this.collectionPath,
    };
    const stmt = compileSelectGlobal(
      this.collectionPath,
      plan.filters,
      plan.options,
      scopeNameFilter,
    );
    const rows = await this.executor.all(stmt.sql, stmt.params);
    return rows.map(rowToRecord);
  }

  // --- Aggregate ---

  /**
   * Run an aggregate query in a single SQL statement. Supports the full
   * count/sum/avg/min/max set — the SQLite engine evaluates each aggregate
   * function over the filtered row set and the executor returns one row
   * with one column per alias. SUM/MIN/MAX of an empty set returns 0
   * (SQLite's `SUM(NULL) = NULL` is mapped to a clean number for the
   * cross-backend contract); AVG returns NaN, matching the mathematical
   * convention and the Firestore Standard helper.
   */
  async aggregate(spec: AggregateSpec, filters: QueryFilter[]): Promise<Record<string, number>> {
    const { stmt, aliases } = compileAggregate(
      this.collectionPath,
      this.storageScope,
      spec,
      filters,
    );
    const rows = await this.executor.all(stmt.sql, stmt.params);
    const row = rows[0] ?? {};
    const out: Record<string, number> = {};
    for (const alias of aliases) {
      const v = row[alias];
      if (v === null || v === undefined) {
        // SQLite returns NULL for SUM/MIN/MAX over an empty set. Resolve
        // to 0 for SUM/MIN/MAX (well-defined) and NaN for AVG (empty-set
        // average is undefined). COUNT(*) is never null.
        const op = spec[alias].op;
        out[alias] = op === 'avg' ? Number.NaN : 0;
      } else if (typeof v === 'bigint') {
        out[alias] = Number(v);
      } else if (typeof v === 'number') {
        out[alias] = v;
      } else {
        // Some drivers return strings for very large or precise numerics.
        // Coerce defensively — the contract is `number`.
        out[alias] = Number(v);
      }
    }
    return out;
  }

  // --- Server-side DML ---

  /**
   * Delete every row matching `filters` in a single SQL DELETE statement.
   *
   * Uses `RETURNING "doc_id"` to count rows touched — the SQLite executor's
   * `run` returns void, so RETURNING + `all()` is the portable way to learn
   * how many rows the engine actually deleted. SQLite ≥ 3.35 supports
   * `DELETE … RETURNING`; better-sqlite3, D1, and DO SQLite all run on a
   * recent enough engine.
   *
   * Single-statement DML doesn't chunk: the engine handles N rows in one
   * shot, so `BulkOptions.batchSize` is intentionally ignored. The retry
   * loop here exists only for transient driver errors (e.g. D1 surface
   * congestion); a permanent failure is surfaced via the `errors` array
   * with `batchIndex: 0` so callers see the same shape as `bulkRemoveEdges`.
   *
   * Subgraph scoping is enforced inside `compileBulkDelete` (the leading
   * `"scope" = ?` predicate) so this method, like every other backend
   * surface, naturally honours subgraph isolation.
   */
  async bulkDelete(filters: QueryFilter[], options?: BulkOptions): Promise<BulkResult> {
    const stmt = compileBulkDelete(this.collectionPath, this.storageScope, filters);
    return this.executeDmlWithReturning(stmt, options);
  }

  /**
   * Update every row matching `filters` with `patch.data` in a single SQL
   * UPDATE statement. The patch is deep-merged into each row's `data`
   * column via the same `flattenPatch` → `compileDataOpsExpr` pipeline that
   * `compileUpdate` (single-row) uses.
   *
   * Same contract notes as `bulkDelete` apply: single-statement, no
   * chunking, `RETURNING "doc_id"` for the affected count, retry loop for
   * transient driver errors.
   */
  async bulkUpdate(
    filters: QueryFilter[],
    patch: BulkUpdatePatch,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    const stmt = compileBulkUpdate(
      this.collectionPath,
      this.storageScope,
      filters,
      patch.data,
      Date.now(),
    );
    return this.executeDmlWithReturning(stmt, options);
  }

  /**
   * Multi-source fan-out — `query.join` capability.
   *
   * Issues a single `SELECT … WHERE "aUid" IN (?, ?, …)` statement that
   * matches every edge from every source UID in one round trip. When
   * `params.hydrate === true`, follows up with a second statement that
   * fetches the target node rows; both queries hit the same table so
   * the executor amortises connection / parsing cost across them.
   *
   * Empty `params.sources` short-circuits to an empty result without
   * touching the executor — `IN ()` is not valid SQL.
   *
   * Per-source ordering / strict per-source LIMIT enforcement is NOT
   * implemented here; see the `ExpandParams.limitPerSource` JSDoc and
   * `compileExpand` for the cap semantics. Strict per-source caps would
   * require window functions and were judged out of scope for the
   * round-trip-collapse goal.
   */
  async expand(params: ExpandParams): Promise<ExpandResult> {
    if (params.sources.length === 0) {
      return params.hydrate ? { edges: [], targets: [] } : { edges: [] };
    }
    const stmt = compileExpand(this.collectionPath, this.storageScope, params);
    const rows = await this.executor.all(stmt.sql, stmt.params);
    const edges = rows.map(rowToRecord);
    if (!params.hydrate) {
      return { edges };
    }
    // Hydration: fetch target nodes for every edge in one IN-clause statement.
    // The "target" side depends on direction — forward hops point at `bUid`,
    // reverse hops point at `aUid`.
    const direction = params.direction ?? 'forward';
    const targetUids = edges.map((e) => (direction === 'forward' ? e.bUid : e.aUid));
    const uniqueTargets = [...new Set(targetUids)];
    if (uniqueTargets.length === 0) {
      return { edges, targets: [] };
    }
    const hydrateStmt = compileExpandHydrate(this.collectionPath, this.storageScope, uniqueTargets);
    const hydrateRows = await this.executor.all(hydrateStmt.sql, hydrateStmt.params);
    const byUid = new Map<string, StoredGraphRecord>();
    for (const row of hydrateRows) {
      const node = rowToRecord(row);
      // Node UID is `bUid` (== `aUid` for self-loop) by convention. Key the
      // map by `bUid` so the alignment loop below indexes correctly.
      byUid.set(node.bUid, node);
    }
    const targets = targetUids.map((uid) => byUid.get(uid) ?? null);
    return { edges, targets };
  }

  /**
   * Server-side projection — `query.select` capability.
   *
   * Issues a single `SELECT json_extract(data, '$.f1'), …` statement that
   * returns only the requested fields. The compiler emits one column per
   * unique field plus a paired `json_type` column for `data.*` projections
   * so the decoder can recover JSON-encoded objects/arrays without a
   * second round trip. Migrations are NOT applied — the caller asked for
   * a partial shape, and rehydrating that into the migration pipeline
   * would require synthesising every absent field.
   *
   * The wire-payload reduction is the entire reason this method exists:
   * a list view that only needs `title` / `date` no longer drags the
   * full `data` JSON across the network. Callers that need the full
   * record should use `findEdges` (with migration support).
   */
  async findEdgesProjected(
    select: ReadonlyArray<string>,
    filters: QueryFilter[],
    options?: QueryOptions,
  ): Promise<Array<Record<string, unknown>>> {
    const { stmt, columns } = compileFindEdgesProjected(
      this.collectionPath,
      this.storageScope,
      select,
      filters,
      options,
    );
    const rows = await this.executor.all(stmt.sql, stmt.params);
    return rows.map((row) => decodeProjectedRow(row, columns));
  }

  /**
   * Run a DML statement with `RETURNING "doc_id"` so we can count the
   * rows the engine touched, with the same retry/backoff contract as
   * `executeChunkedBatches`. Single statement, single batch.
   */
  private async executeDmlWithReturning(
    stmt: CompiledStatement,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const rows = await this.executor.all(sqlWithReturning, stmt.params);
        const deleted = rows.length;
        if (options?.onProgress) {
          options.onProgress({
            completedBatches: 1,
            totalBatches: 1,
            deletedSoFar: deleted,
          });
        }
        return { deleted, batches: 1, errors: [] };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
          await sleep(delay);
        }
      }
    }
    // `operationCount` is genuinely unknown for a server-side DML — we
    // don't know how many rows the failed statement would have touched.
    // Report 0 as the lower bound; callers concerned about partial state
    // should re-query and reconcile.
    return {
      deleted: 0,
      batches: 0,
      errors: [
        {
          batchIndex: 0,
          error: lastError ?? new Error('bulk DML failed for unknown reason'),
          operationCount: 0,
        },
      ],
    };
  }
}

/**
 * Create a SQLite-backed `StorageBackend`.
 *
 * `tableName` is the single table that holds every triple. The driver must
 * have already created the table and indexes via `buildSchemaStatements()`
 * before any reads/writes arrive — callers that ship their own SQLite
 * driver are responsible for wiring that up.
 */
export function createSqliteBackend(
  executor: SqliteExecutor,
  tableName: string,
  options: SqliteBackendOptions = {},
): StorageBackend<SqliteCapability> {
  const storageScope = options.storageScope ?? '';
  const scopePath = options.scopePath ?? '';
  return new SqliteBackendImpl(executor, tableName, storageScope, scopePath);
}
