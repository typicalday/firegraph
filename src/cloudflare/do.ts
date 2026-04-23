/**
 * `FiregraphDO` — the Durable Object class that holds a single subgraph's
 * triples.
 *
 * The Cloudflare-native Firegraph design puts each subgraph in its own DO
 * instance: the root graph in one DO, `client.subgraph(uid, 'memories')` in
 * another, nested subgraphs in their own DOs, and so on. Each DO owns a
 * private flat SQLite database (`src/cloudflare/schema.ts`) — no `scope`
 * column, no shared table, no discriminator. The client routes to a
 * specific DO by hashing a stable name (`namespace.idFromName(storageKey)`);
 * on first RPC, the DO lazily materializes and runs the schema DDL.
 *
 * ## Using it in a Worker
 *
 * Bind the class in `wrangler.toml` and re-export it from the Worker entry:
 *
 * ```toml
 * [[durable_objects.bindings]]
 * name = "GRAPH"
 * class_name = "FiregraphDO"
 *
 * [[migrations]]
 * tag = "v1"
 * new_sqlite_classes = ["FiregraphDO"]
 * ```
 *
 * ```ts
 * // worker.ts
 * export { FiregraphDO } from '@typicalday/firegraph/cloudflare';
 * ```
 *
 * To add custom RPC methods, extend the class:
 *
 * ```ts
 * export class GraphDO extends FiregraphDO {
 *   async myCustomRpc() { ... }
 * }
 * ```
 *
 * ## Why a plain class (not `extends DurableObject`)?
 *
 * Cloudflare accepts any class with the `(state, env)` constructor shape as
 * a DO class. Extending `DurableObject` from `cloudflare:workers` would pull
 * a runtime import into this module and prevent it from loading in Node
 * tests. The plain-class form keeps this file runtime-neutral — the only
 * Cloudflare thing we touch is `ctx.storage.sql`, typed via local minimal
 * interfaces.
 */

import { computeEdgeDocId, computeNodeDocId } from '../docid.js';
import { FiregraphError } from '../errors.js';
import type { UpdatePayload, WritableRecord } from '../internal/backend.js';
import { NODE_RELATION } from '../internal/constants.js';
import { buildEdgeQueryPlan } from '../query.js';
import type {
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphRegistry,
  IndexSpec,
  QueryFilter,
  QueryOptions,
} from '../types.js';
import { buildDOSchemaStatements, validateDOTableName } from './schema.js';
import type { CompiledStatement, DORecordWire } from './sql.js';
import {
  compileDODelete,
  compileDODeleteAll,
  compileDOSelect,
  compileDOSelectByDocId,
  compileDOSet,
  compileDOUpdate,
  rowToDORecord,
} from './sql.js';

// ---------------------------------------------------------------------------
// Minimal DO runtime types — declared locally so this module doesn't depend
// on `@cloudflare/workers-types`. Users importing the library get their own
// `DurableObjectState` from workers-types; structurally the two shapes are
// compatible.
// ---------------------------------------------------------------------------

export interface DOSqlCursor<T> {
  toArray(): T[];
}

export interface DOSqlExecutor {
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): DOSqlCursor<T>;
}

export interface DOStorage {
  sql: DOSqlExecutor;
  transactionSync<T>(fn: () => T): T;
}

export interface DurableObjectStateLike {
  readonly storage: DOStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// RPC wire shapes
// ---------------------------------------------------------------------------

/**
 * One op in a `batch()` RPC call. Discriminated by `kind` so the DO can
 * dispatch to the correct compiler.
 */
export type BatchOp =
  | { kind: 'set'; docId: string; record: WritableRecord }
  | { kind: 'update'; docId: string; update: UpdatePayload }
  | { kind: 'delete'; docId: string };

/**
 * Options controlling `FiregraphDO` construction.
 */
export interface FiregraphDOOptions {
  /** Table name for firegraph triples. Default: `firegraph`. */
  table?: string;
  /** Run schema DDL on first boot. Default: `true`. */
  autoMigrate?: boolean;
  /**
   * Registry whose per-entry `indexes` get compiled into `CREATE INDEX`
   * statements during schema bootstrap. Supply the same registry you pass
   * to `createGraphClient` on the Worker side to keep DO and client in sync.
   */
  registry?: GraphRegistry;
  /**
   * Replaces the built-in core index preset
   * (`DEFAULT_CORE_INDEXES`). Supply this when the default set of
   * `(aUid, axbType)`, `(axbType, bUid)`, etc. composites doesn't fit your
   * query shapes — e.g., you want descending timestamps or a reduced set.
   * Entry-level `RegistryEntry.indexes` remain additive on top.
   *
   * Pass `[]` to disable core indexes entirely (advanced — only safe when
   * the provided `registry`'s entries cover every query shape your app
   * issues).
   */
  coreIndexes?: IndexSpec[];
}

// ---------------------------------------------------------------------------
// FiregraphDO
// ---------------------------------------------------------------------------

/**
 * Default `FiregraphDO` options, used when a subclass calls `super(ctx, env)`
 * without passing options. Overridable in subclasses via constructor args.
 *
 * Only fields with a universal sensible default go here — optional index
 * and registry wiring is `undefined` by default and threaded through
 * `runSchema` as-is.
 */
const DEFAULT_OPTIONS: Required<Pick<FiregraphDOOptions, 'table' | 'autoMigrate'>> = {
  table: 'firegraph',
  autoMigrate: true,
};

export class FiregraphDO {
  /** @internal — exposed for subclass access, not part of the public RPC. */
  protected readonly ctx: DurableObjectStateLike;
  /** @internal — exposed for subclass access; opaque to this class. */
  protected readonly env: unknown;
  /** @internal — table name used by every compiled statement. */
  protected readonly table: string;
  /** @internal — registry consulted by `runSchema` for per-entry indexes. */
  protected readonly registry?: GraphRegistry;
  /** @internal — overrides `DEFAULT_CORE_INDEXES` when set. */
  protected readonly coreIndexes?: IndexSpec[];

  constructor(ctx: DurableObjectStateLike, env: unknown, options: FiregraphDOOptions = {}) {
    this.ctx = ctx;
    this.env = env;
    const table = options.table ?? DEFAULT_OPTIONS.table;
    validateDOTableName(table);
    this.table = table;
    this.registry = options.registry;
    this.coreIndexes = options.coreIndexes;

    const autoMigrate = options.autoMigrate ?? DEFAULT_OPTIONS.autoMigrate;
    if (autoMigrate) {
      // `blockConcurrencyWhile` defers any incoming RPC until the schema is
      // in place. Without it a fast first caller could run a query against an
      // empty database before the CREATE TABLE lands.
      //
      // Fire-and-forget is safe: the DO runtime internally tracks and awaits
      // the returned promise, holding the RPC input queue until the schema
      // materializes. We don't need to `await` it from the constructor (which
      // can't be async anyway) — the next incoming RPC already waits.
      void this.ctx.blockConcurrencyWhile(async () => {
        this.runSchema();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // RPC: reads
  //
  // Method names are prefixed `_fg` so user subclasses can add their own RPC
  // methods without name collisions. The client-side backend in
  // `src/cloudflare/backend.ts` calls these directly on the DO stub.
  // ---------------------------------------------------------------------------

  async _fgGetDoc(docId: string): Promise<DORecordWire | null> {
    const stmt = compileDOSelectByDocId(this.table, docId);
    const rows = this.execAll(stmt);
    return rows.length === 0 ? null : rowToDORecord(rows[0]);
  }

  async _fgQuery(filters: QueryFilter[], options?: QueryOptions): Promise<DORecordWire[]> {
    const stmt = compileDOSelect(this.table, filters, options);
    const rows = this.execAll(stmt);
    return rows.map(rowToDORecord);
  }

  // ---------------------------------------------------------------------------
  // RPC: writes
  // ---------------------------------------------------------------------------

  async _fgSetDoc(docId: string, record: WritableRecord): Promise<void> {
    const stmt = compileDOSet(this.table, docId, record, Date.now());
    this.execRun(stmt);
  }

  async _fgUpdateDoc(docId: string, update: UpdatePayload): Promise<void> {
    const stmt = compileDOUpdate(this.table, docId, update, Date.now());
    // RETURNING lets us surface NOT_FOUND at the client, matching Firestore's
    // `update()` semantics. SQLite ≥3.35 supports UPDATE … RETURNING and DO
    // SQLite is always recent enough.
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    const rows = this.ctx.storage.sql
      .exec<Record<string, unknown>>(sqlWithReturning, ...stmt.params)
      .toArray();
    if (rows.length === 0) {
      throw new FiregraphError(`updateDoc: no document found for doc_id=${docId}`, 'NOT_FOUND');
    }
  }

  async _fgDeleteDoc(docId: string): Promise<void> {
    const stmt = compileDODelete(this.table, docId);
    this.execRun(stmt);
  }

  // ---------------------------------------------------------------------------
  // RPC: batch
  // ---------------------------------------------------------------------------

  /**
   * Execute a list of write ops atomically. DO SQLite's `transactionSync`
   * provides real atomicity — either every statement commits or none do.
   * No statement-count cap applies (contrast with D1's ~100-statement batch
   * limit), so the caller can submit as many ops as they like in one call.
   */
  async _fgBatch(ops: BatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    const now = Date.now();
    const statements: CompiledStatement[] = ops.map((op) => {
      switch (op.kind) {
        case 'set':
          return compileDOSet(this.table, op.docId, op.record, now);
        case 'update':
          return compileDOUpdate(this.table, op.docId, op.update, now);
        case 'delete':
          return compileDODelete(this.table, op.docId);
      }
    });
    this.ctx.storage.transactionSync(() => {
      for (const stmt of statements) {
        this.ctx.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // RPC: cascade + bulk (local DO only)
  //
  // These cascade *within this DO*. Subgraph DOs (nested under this node) are
  // not reachable from here — the client-side `DORPCBackend.removeNodeCascade`
  // consults the registry topology to discover descendant subgraph DOs and
  // fans out explicit `_fgDestroy` calls to each before invoking this method.
  // Without that topology the DO has no way to enumerate its children.
  // ---------------------------------------------------------------------------

  async _fgRemoveNodeCascade(uid: string): Promise<CascadeResult> {
    // Gather every edge whose aUid or bUid matches the node. The self-loop
    // (node record) is identified separately so we can report it distinctly
    // in `CascadeResult` — and so we don't falsely claim `nodeDeleted: true`
    // when the node never existed.
    const outgoingStmt = compileDOSelect(this.table, [{ field: 'aUid', op: '==', value: uid }]);
    const incomingStmt = compileDOSelect(this.table, [{ field: 'bUid', op: '==', value: uid }]);
    const outgoingRows = this.execAll(outgoingStmt);
    const incomingRows = this.execAll(incomingStmt);

    const seen = new Set<string>();
    const edgeDocIds: string[] = [];
    let nodeExists = false;
    for (const row of [...outgoingRows, ...incomingRows]) {
      const axbType = row.axb_type as string;
      const aUid = row.a_uid as string;
      const bUid = row.b_uid as string;
      if (axbType === NODE_RELATION && aUid === bUid) {
        nodeExists = true;
        continue;
      }
      const docId = computeEdgeDocId(aUid, axbType, bUid);
      if (!seen.has(docId)) {
        seen.add(docId);
        edgeDocIds.push(docId);
      }
    }

    const statements: CompiledStatement[] = edgeDocIds.map((id) => compileDODelete(this.table, id));
    // Only queue the node delete if the self-loop was actually present; a
    // cascade on a nonexistent node returns `nodeDeleted: false` without
    // a wasted DELETE. Orphan edges still get cleaned up either way.
    if (nodeExists) {
      statements.push(compileDODelete(this.table, computeNodeDocId(uid)));
    }

    if (statements.length === 0) {
      return {
        deleted: 0,
        batches: 0,
        errors: [],
        edgesDeleted: 0,
        nodeDeleted: false,
      };
    }

    try {
      this.ctx.storage.transactionSync(() => {
        for (const stmt of statements) {
          this.ctx.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
        }
      });
      return {
        deleted: statements.length,
        batches: 1,
        errors: [],
        edgesDeleted: edgeDocIds.length,
        nodeDeleted: nodeExists,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        deleted: 0,
        batches: 0,
        errors: [{ batchIndex: 0, error, operationCount: statements.length }],
        edgesDeleted: 0,
        nodeDeleted: false,
      };
    }
  }

  async _fgBulkRemoveEdges(params: FindEdgesParams, _options?: BulkOptions): Promise<BulkResult> {
    // Resolve the set of doc IDs to delete. For a fully-specified query
    // (`get` plan) the planner hands us the doc ID directly — we still
    // verify existence so the returned count reflects reality. For partial
    // queries we run the SELECT and collect every matching edge's doc ID.
    // `allowCollectionScan` / scan protection are deliberately ignored at
    // this layer — the client has already authorized the delete.
    const plan = buildEdgeQueryPlan(params);
    let docIds: string[];
    if (plan.strategy === 'get') {
      const existsStmt = compileDOSelectByDocId(this.table, plan.docId);
      const rows = this.execAll(existsStmt);
      docIds = rows.length > 0 ? [plan.docId] : [];
    } else {
      const selectStmt = compileDOSelect(this.table, plan.filters, plan.options);
      const rows = this.execAll(selectStmt);
      docIds = rows.map((row) =>
        computeEdgeDocId(row.a_uid as string, row.axb_type as string, row.b_uid as string),
      );
    }

    if (docIds.length === 0) {
      return { deleted: 0, batches: 0, errors: [] };
    }

    const deleteStmts = docIds.map((id) => compileDODelete(this.table, id));
    try {
      this.ctx.storage.transactionSync(() => {
        for (const stmt of deleteStmts) {
          this.ctx.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
        }
      });
      return { deleted: deleteStmts.length, batches: 1, errors: [] };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        deleted: 0,
        batches: 0,
        errors: [{ batchIndex: 0, error, operationCount: deleteStmts.length }],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // RPC: admin
  // ---------------------------------------------------------------------------

  /**
   * Wipe every row. Called by the client when tearing down a subgraph DO as
   * part of cascade — the DO itself can't be destroyed (DO IDs persist
   * forever), but its storage can be emptied.
   */
  async _fgDestroy(): Promise<void> {
    const stmt = compileDODeleteAll(this.table);
    this.execRun(stmt);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  protected runSchema(): void {
    const statements = buildDOSchemaStatements(this.table, {
      coreIndexes: this.coreIndexes,
      registry: this.registry,
    });
    for (const sql of statements) {
      this.ctx.storage.sql.exec(sql).toArray();
    }
  }

  private execAll(stmt: CompiledStatement): Record<string, unknown>[] {
    return this.ctx.storage.sql.exec<Record<string, unknown>>(stmt.sql, ...stmt.params).toArray();
  }

  private execRun(stmt: CompiledStatement): void {
    // DO SQL `exec` returns a cursor even for writes; consuming it via
    // `toArray()` forces execution and surfaces constraint errors
    // synchronously.
    this.ctx.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
  }
}
