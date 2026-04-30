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
 * ## Why `extends DurableObject`?
 *
 * Cloudflare's modern Durable Objects RPC dispatcher only accepts arbitrary
 * method invocations on stubs whose backing class extends the special
 * `DurableObject` base from `cloudflare:workers`. Plain classes with the
 * `(state, env)` constructor shape still load and serve `fetch()`, but a
 * stub method call (`stub._fgGetDoc(...)`) on a plain-class DO throws:
 *
 *   The receiving Durable Object does not support RPC, because its class
 *   was not declared with `extends DurableObject`.
 *
 * `DORPCBackend` calls every operation as a stub method (see
 * `src/cloudflare/backend.ts`), so extending `DurableObject` is mandatory
 * for this library's design to work on production Workers.
 *
 * The `cloudflare:workers` import is virtual — only the workerd runtime
 * resolves it. For Node tests we route the import through a vitest alias
 * to a tiny stub class (`tests/__shims__/cloudflare-workers.ts`) that just
 * captures `ctx`/`env`. Tests instantiating `FiregraphDO` directly still
 * work; they just go through the stub instead of the real base class.
 */

// `cloudflare:workers` is a virtual module — only the workerd runtime resolves
// it. TypeScript needs to know the `DurableObject` base class shape at compile
// time, which ships in `@cloudflare/workers-types`'s ambient `index.d.ts`.
// Listing that package in `compilerOptions.types` would add 479KB of global
// declarations to every source file's lookup scope (8min typecheck — see the
// commit that added this file). Instead we pull it in once via the
// triple-slash reference below so the cost is bounded to this one file.
/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from 'cloudflare:workers';

import { computeEdgeDocId, computeNodeDocId } from '../docid.js';
import { FiregraphError } from '../errors.js';
import type { UpdatePayload, WritableRecord, WriteMode } from '../internal/backend.js';
import { NODE_RELATION } from '../internal/constants.js';
import { buildEdgeQueryPlan } from '../query.js';
import type {
  AggregateSpec,
  BulkOptions,
  BulkResult,
  BulkUpdatePatch,
  CascadeResult,
  ExpandParams,
  FindEdgesParams,
  GraphRegistry,
  IndexSpec,
  QueryFilter,
  QueryOptions,
} from '../types.js';
import type { ExpandResultWire } from './backend.js';
import { buildDOSchemaStatements, validateDOTableName } from './schema.js';
import type { CompiledStatement, DOProjectedColumnSpec, DORecordWire } from './sql.js';
import {
  compileDOAggregate,
  compileDOBulkDelete,
  compileDOBulkUpdate,
  compileDODelete,
  compileDODeleteAll,
  compileDOExpand,
  compileDOExpandHydrate,
  compileDOFindEdgesProjected,
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
  | { kind: 'set'; docId: string; record: WritableRecord; mode: WriteMode }
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

export class FiregraphDO extends DurableObject<unknown> {
  /**
   * @internal — locally-narrowed alias for `this.ctx`, used only by
   * FiregraphDO's own SQL helpers. Same runtime object as the inherited
   * `this.ctx`, but typed as `DurableObjectStateLike` (just `storage.sql`
   * / `transactionSync` / `blockConcurrencyWhile`) so internal calls
   * don't trip over workers-types' stricter
   * `SqlStorage.exec<T extends Record<string, SqlStorageValue>>`
   * constraint vs the `Record<string, unknown>` rows firegraph passes.
   *
   * **Subclasses should use `this.ctx`, not `this.state`.** `this.state`
   * deliberately exposes only the slice FiregraphDO needs internally;
   * subclasses that want `id`, `acceptWebSocket`, `setAlarm`, `getAlarm`,
   * `waitUntil`, `props`, etc. must reach for the inherited `this.ctx`
   * (the full workers-types `DurableObjectState`).
   */
  protected readonly state: DurableObjectStateLike;
  /** @internal — table name used by every compiled statement. */
  protected readonly table: string;
  /** @internal — registry consulted by `runSchema` for per-entry indexes. */
  protected readonly registry?: GraphRegistry;
  /** @internal — overrides `DEFAULT_CORE_INDEXES` when set. */
  protected readonly coreIndexes?: IndexSpec[];

  constructor(ctx: DurableObjectStateLike, env: unknown, options: FiregraphDOOptions = {}) {
    // The base `DurableObject` constructor expects the workers-types
    // `DurableObjectState`. Our public signature uses
    // `DurableObjectStateLike` (a structural subset) so consumers don't
    // need workers-types just to subclass. Cast via `unknown as
    // DurableObjectState` — narrower than `as never`: it still allows the
    // structurally-compatible value through, but if Cloudflare ever
    // tightens `DurableObjectState` (extra constructor param, new
    // required method) the type checker will surface the drift instead
    // of silently swallowing it.
    super(ctx as unknown as DurableObjectState, env);
    this.state = ctx;
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
      void this.state.blockConcurrencyWhile(async () => {
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

  /**
   * Aggregate query (capability `query.aggregate`). Compiles a single
   * `SELECT` projecting one column per alias; SQLite handles count, sum,
   * avg, min, max natively. Empty-set fix-ups (NULL → 0 for sum/min/max,
   * NaN for avg) happen on the client side in `DORPCBackend.aggregate` so
   * the wire payload stays a plain row of (alias → number | null).
   */
  async _fgAggregate(
    spec: AggregateSpec,
    filters: QueryFilter[],
  ): Promise<Record<string, number | null>> {
    const { stmt, aliases } = compileDOAggregate(this.table, spec, filters);
    const rows = this.execAll(stmt);
    const row = rows[0] ?? {};
    const out: Record<string, number | null> = {};
    for (const alias of aliases) {
      const v = (row as Record<string, unknown>)[alias];
      if (v === null || v === undefined) out[alias] = null;
      else if (typeof v === 'bigint') out[alias] = Number(v);
      else if (typeof v === 'number') out[alias] = v;
      else out[alias] = Number(v);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // RPC: writes
  // ---------------------------------------------------------------------------

  async _fgSetDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    const stmt = compileDOSet(this.table, docId, record, Date.now(), mode);
    this.execRun(stmt);
  }

  async _fgUpdateDoc(docId: string, update: UpdatePayload): Promise<void> {
    const stmt = compileDOUpdate(this.table, docId, update, Date.now());
    // RETURNING lets us surface NOT_FOUND at the client, matching Firestore's
    // `update()` semantics. SQLite ≥3.35 supports UPDATE … RETURNING and DO
    // SQLite is always recent enough.
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    const rows = this.state.storage.sql
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
          return compileDOSet(this.table, op.docId, op.record, now, op.mode);
        case 'update':
          return compileDOUpdate(this.table, op.docId, op.update, now);
        case 'delete':
          return compileDODelete(this.table, op.docId);
      }
    });
    this.state.storage.transactionSync(() => {
      for (const stmt of statements) {
        this.state.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
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
      this.state.storage.transactionSync(() => {
        for (const stmt of statements) {
          this.state.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
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
      this.state.storage.transactionSync(() => {
        for (const stmt of deleteStmts) {
          this.state.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
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
  // RPC: server-side DML (capability `query.dml`)
  //
  // Single-statement DELETE/UPDATE WHERE that the SQLite engine handles in
  // one shot — the cap-less alternative is `_fgBulkRemoveEdges` which fetches
  // doc IDs first, then deletes them one-by-one inside a transaction. The
  // DML path skips the round-trip and lets SQLite optimize the WHERE.
  //
  // RETURNING "doc_id" gives us an authoritative affected-row count; SQLite
  // ≥3.35 supports it for both DELETE and UPDATE and DO SQLite is always
  // recent enough.
  //
  // Retry policy: unlike `SqliteBackendImpl.bulkDelete` / `bulkUpdate`, which
  // wrap a chunked retry/backoff loop around each batch (D1's 1000-statement
  // cap forces chunking, so a single transient failure shouldn't kill the
  // whole job), the DO path runs a single un-chunked statement against
  // `state.storage.sql` synchronously. There's nothing to retry inside the
  // DO — the engine commits or it doesn't. If a caller wants retry semantics
  // on the wire, they wrap the `bulkDelete` / `bulkUpdate` call themselves.
  // ---------------------------------------------------------------------------

  async _fgBulkDelete(filters: QueryFilter[], _options?: BulkOptions): Promise<BulkResult> {
    void _options;
    // Defense-in-depth at the wire boundary: an empty filter list compiles
    // to `DELETE FROM <table>` and would wipe every row in the DO. The
    // client's `bulkDelete` already gates this through scan protection, but
    // a hand-rolled stub wrapper or direct RPC caller would bypass that
    // gate. Reject here so the DO's wire surface is safe regardless of
    // caller path. Use `_fgRemoveNodeCascade` or `_fgDestroy` to wipe a
    // routed subgraph DO.
    if (filters.length === 0) {
      throw new FiregraphError(
        'bulkDelete() requires at least one filter when targeting a Durable Object backend. ' +
          'An empty filter list would wipe every row in the DO. To wipe a routed ' +
          'subgraph DO, use `removeNodeCascade` on the parent node or `_fgDestroy` ' +
          'directly on the stub.',
        'INVALID_ARGUMENT',
      );
    }
    const stmt = compileDOBulkDelete(this.table, filters);
    return this.execDmlWithReturning(stmt);
  }

  async _fgBulkUpdate(
    filters: QueryFilter[],
    patch: BulkUpdatePatch,
    _options?: BulkOptions,
  ): Promise<BulkResult> {
    void _options;
    const stmt = compileDOBulkUpdate(this.table, filters, patch.data, Date.now());
    return this.execDmlWithReturning(stmt);
  }

  // ---------------------------------------------------------------------------
  // RPC: multi-source fan-out (`query.join`)
  //
  // One `SELECT … WHERE "aUid" IN (?, ?, …)` (or `"bUid"` for reverse)
  // collapses N per-source `findEdges` round trips into one. When the
  // caller asks for hydration, a second IN-clause statement fetches the
  // target node rows; the DO does the alignment in JS so the wire payload
  // is two `DORecordWire[]` arrays instead of a JOIN-shaped row that
  // would force a custom client-side decoder.
  // ---------------------------------------------------------------------------

  async _fgExpand(params: ExpandParams): Promise<ExpandResultWire> {
    if (params.sources.length === 0) {
      return params.hydrate ? { edges: [], targets: [] } : { edges: [] };
    }
    const stmt = compileDOExpand(this.table, params);
    const rows = this.state.storage.sql
      .exec<Record<string, unknown>>(stmt.sql, ...stmt.params)
      .toArray();
    const edges = rows.map((row) => rowToDORecord(row));
    if (!params.hydrate) {
      return { edges };
    }
    // Same alignment story as `SqliteBackendImpl.expand` — collect distinct
    // target UIDs, fetch them in one IN-clause statement, build a Map keyed
    // by node UID (== `bUid` for self-loops), then walk the original edge
    // list to produce the index-aligned `targets` array.
    const direction = params.direction ?? 'forward';
    const targetUids = edges.map((e) => (direction === 'forward' ? e.bUid : e.aUid));
    const uniqueTargets = [...new Set(targetUids)];
    if (uniqueTargets.length === 0) {
      return { edges, targets: [] };
    }
    const hydrateStmt = compileDOExpandHydrate(this.table, uniqueTargets);
    const hydrateRows = this.state.storage.sql
      .exec<Record<string, unknown>>(hydrateStmt.sql, ...hydrateStmt.params)
      .toArray();
    const byUid = new Map<string, DORecordWire>();
    for (const row of hydrateRows) {
      const node = rowToDORecord(row);
      byUid.set(node.bUid, node);
    }
    const targets = targetUids.map((uid) => byUid.get(uid) ?? null);
    return { edges, targets };
  }

  // ---------------------------------------------------------------------------
  // RPC: server-side projection (`query.select`)
  //
  // One `SELECT json_extract(data, '$.f1'), …` returns the projected fields.
  // The DO leaves decoding to the client because timestamp values need to
  // rewrap as `GraphTimestampImpl` (a class instance, lost by structured
  // clone) — instead of inventing per-field timestamp sentinels, we send the
  // raw rows and the column spec, and let `DORPCBackend.findEdgesProjected`
  // call `decodeDOProjectedRow` once. The spec is small (≤ ~100 bytes for
  // a typical projection); structured clone copes happily.
  // ---------------------------------------------------------------------------

  async _fgFindEdgesProjected(
    select: ReadonlyArray<string>,
    filters: QueryFilter[],
    options?: QueryOptions,
  ): Promise<{ rows: Array<Record<string, unknown>>; columns: DOProjectedColumnSpec[] }> {
    const { stmt, columns } = compileDOFindEdgesProjected(this.table, select, filters, options);
    const rows = this.state.storage.sql
      .exec<Record<string, unknown>>(stmt.sql, ...stmt.params)
      .toArray();
    return { rows, columns };
  }

  /**
   * Run a DML statement with `RETURNING "doc_id"` so the affected-row count
   * comes back authoritatively. Errors are caught and surfaced via the
   * `BulkResult.errors` array (single batch, batchIndex 0) so the wire
   * payload stays a regular `BulkResult` and the client doesn't have to
   * differentiate "RPC threw" from "single-statement failure."
   */
  private execDmlWithReturning(stmt: CompiledStatement): BulkResult {
    const sqlWithReturning = `${stmt.sql} RETURNING "doc_id"`;
    try {
      const rows = this.state.storage.sql
        .exec<Record<string, unknown>>(sqlWithReturning, ...stmt.params)
        .toArray();
      return { deleted: rows.length, batches: 1, errors: [] };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        deleted: 0,
        batches: 0,
        // Like `_fgBulkRemoveEdges`'s catch arm: a single failed statement
        // is one batch, and the operationCount is "unknown" for a server-
        // side DML — we report 0 as the lower bound. Callers that care
        // about partial state should re-query and reconcile.
        errors: [{ batchIndex: 0, error, operationCount: 0 }],
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
      this.state.storage.sql.exec(sql).toArray();
    }
  }

  private execAll(stmt: CompiledStatement): Record<string, unknown>[] {
    return this.state.storage.sql.exec<Record<string, unknown>>(stmt.sql, ...stmt.params).toArray();
  }

  private execRun(stmt: CompiledStatement): void {
    // DO SQL `exec` returns a cursor even for writes; consuming it via
    // `toArray()` forces execution and surfaces constraint errors
    // synchronously.
    this.state.storage.sql.exec(stmt.sql, ...stmt.params).toArray();
  }
}
