/**
 * Client-side `StorageBackend` that forwards every operation to a
 * `FiregraphDO` instance over Durable Object RPC.
 *
 * One `DORPCBackend` corresponds to one DO — the root graph's DO, or a
 * subgraph's DO. `subgraph()` returns a new `DORPCBackend` bound to a
 * different DO, identified by deriving a new stable name from the chain of
 * parent UIDs and subgraph names. The library uses `namespace.idFromName()`
 * on that key, so two clients with the same key always reach the same DO.
 *
 * Key invariants:
 *
 * - There is no shared table and no `scope` column. Each DO owns its own
 *   flat SQLite database; isolation is physical.
 * - Transactions and `findEdgesGlobal` are phase-1 non-features and throw a
 *   clear `UNSUPPORTED_OPERATION` error. Phase 2 wires cross-subgraph
 *   fan-out against the registry topology.
 * - Cascade inside a single DO works today (see `FiregraphDO._fgRemoveNodeCascade`);
 *   cross-DO cascade (tearing down child-subgraph DOs) is phase 2.
 */

import { FiregraphError } from '../errors.js';
import type {
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
} from '../internal/backend.js';
import type {
  BulkOptions,
  BulkResult,
  CascadeResult,
  FindEdgesParams,
  GraphReader,
  QueryFilter,
  QueryOptions,
  StoredGraphRecord,
} from '../types.js';
import type { BatchOp } from './do.js';
import type { DORecordWire } from './sql.js';
import { hydrateDORecord } from './sql.js';

// ---------------------------------------------------------------------------
// Minimal DO namespace / stub types
//
// We avoid importing `@cloudflare/workers-types` to keep this module usable
// in any TypeScript consumer — users with workers-types installed get the
// richer types via declaration merging at their call site.
// ---------------------------------------------------------------------------

export interface DurableObjectIdLike {
  toString(): string;
}

/**
 * The RPC surface this backend calls on the DO stub. Every method matches a
 * `_fg…` method on `FiregraphDO`. Kept structurally typed so users can bring
 * their own subclass without the types having to know about it.
 *
 * Reads return `DORecordWire` (plain data — safe through DO structured
 * clone); the backend rewraps each record via `hydrateDORecord` before
 * handing it to the GraphClient, which expects `GraphTimestampImpl`
 * instances (not plain `{seconds, nanoseconds}` objects).
 */
export interface FiregraphStub {
  _fgGetDoc(docId: string): Promise<DORecordWire | null>;
  _fgQuery(filters: QueryFilter[], options?: QueryOptions): Promise<DORecordWire[]>;
  _fgSetDoc(docId: string, record: WritableRecord): Promise<void>;
  _fgUpdateDoc(docId: string, update: UpdatePayload): Promise<void>;
  _fgDeleteDoc(docId: string): Promise<void>;
  _fgBatch(ops: BatchOp[]): Promise<void>;
  _fgRemoveNodeCascade(uid: string): Promise<CascadeResult>;
  _fgBulkRemoveEdges(params: FindEdgesParams, options?: BulkOptions): Promise<BulkResult>;
  _fgDestroy(): Promise<void>;
}

export interface FiregraphNamespace {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): FiregraphStub;
}

// ---------------------------------------------------------------------------
// Subgraph name validation
//
// The chain of subgraph segments becomes the input to `idFromName()`. Two
// different paths must produce two different hashes, so segments can't
// contain the `/` separator — otherwise `('A', 'x/y')` and `('A/x', 'y')`
// would collide. The `GraphClient` already validates at the public API
// layer; this is defense-in-depth for direct backend users (traversal,
// cross-graph hops).
// ---------------------------------------------------------------------------

function validateSegment(value: string, label: string): void {
  if (!value || value.includes('/')) {
    throw new FiregraphError(
      `Invalid ${label} for subgraph: "${value}". Must be non-empty and not contain "/".`,
      'INVALID_SUBGRAPH',
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction backend — phase 1 throws
// ---------------------------------------------------------------------------

/**
 * Interactive transactions across DO RPC require holding a synchronous
 * SQLite transaction open across multiple async RPC calls, which blocks the
 * DO's single-threaded executor for the duration. Phase 1 defers that
 * complexity by refusing `runTransaction()`. Callers should restructure
 * read-then-conditional-write logic as an explicit `read → decide → batch`
 * sequence, or use `batch()` for atomic multi-write patterns.
 */
function transactionsUnsupported(): FiregraphError {
  return new FiregraphError(
    'Interactive transactions are not supported by the Cloudflare DO backend in phase 1. ' +
      'Use `batch()` for atomic multi-write commits, or restructure the read-then-conditional-write ' +
      'as an explicit read → decide → batch sequence.',
    'UNSUPPORTED_OPERATION',
  );
}

// ---------------------------------------------------------------------------
// Batch backend — buffers locally, submits one RPC on commit
// ---------------------------------------------------------------------------

class DORPCBatchBackend implements BatchBackend {
  private readonly ops: BatchOp[] = [];

  constructor(private readonly getStub: () => FiregraphStub) {}

  setDoc(docId: string, record: WritableRecord): void {
    this.ops.push({ kind: 'set', docId, record });
  }

  updateDoc(docId: string, update: UpdatePayload): void {
    this.ops.push({ kind: 'update', docId, update });
  }

  deleteDoc(docId: string): void {
    this.ops.push({ kind: 'delete', docId });
  }

  async commit(): Promise<void> {
    if (this.ops.length === 0) return;
    // Pass a shallow copy so that clearing the local buffer after commit
    // doesn't mutate what the stub received. Over real DO RPC the array is
    // already copied via structured clone; in-process tests and any future
    // in-memory stub see the copy explicitly.
    const ops = this.ops.slice();
    this.ops.length = 0;
    await this.getStub()._fgBatch(ops);
  }
}

// ---------------------------------------------------------------------------
// StorageBackend implementation
// ---------------------------------------------------------------------------

export interface DORPCBackendOptions {
  /** Logical table name — informational only, returned via `collectionPath`. */
  table?: string;
  /** Scope path (names-only chain, used for `allowedIn`). Default: `''`. */
  scopePath?: string;
  /**
   * Opaque storage key used to derive the DO instance via
   * `namespace.idFromName(storageKey)`. Defaults to the root key passed to
   * `createDOClient` when the backend is first created.
   */
  storageKey: string;
}

export class DORPCBackend implements StorageBackend {
  readonly collectionPath: string;
  readonly scopePath: string;
  /** @internal */
  readonly storageKey: string;
  private readonly namespace: FiregraphNamespace;
  private cachedStub: FiregraphStub | null = null;

  constructor(namespace: FiregraphNamespace, options: DORPCBackendOptions) {
    this.namespace = namespace;
    this.collectionPath = options.table ?? 'firegraph';
    this.scopePath = options.scopePath ?? '';
    this.storageKey = options.storageKey;
  }

  private get stub(): FiregraphStub {
    if (!this.cachedStub) {
      const id = this.namespace.idFromName(this.storageKey);
      this.cachedStub = this.namespace.get(id);
    }
    return this.cachedStub;
  }

  // --- Reads ---

  async getDoc(docId: string): Promise<StoredGraphRecord | null> {
    const wire = await this.stub._fgGetDoc(docId);
    return wire ? hydrateDORecord(wire) : null;
  }

  async query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    const wires = await this.stub._fgQuery(filters, options);
    return wires.map(hydrateDORecord);
  }

  // --- Writes ---

  async setDoc(docId: string, record: WritableRecord): Promise<void> {
    return this.stub._fgSetDoc(docId, record);
  }

  async updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    return this.stub._fgUpdateDoc(docId, update);
  }

  async deleteDoc(docId: string): Promise<void> {
    return this.stub._fgDeleteDoc(docId);
  }

  // --- Transactions / batches ---

  async runTransaction<T>(_fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
    // Structurally surface the unsupported error — the tx argument passed to
    // `_fn` would throw on every call anyway, but we fail earlier so callers
    // don't discover the limitation mid-transaction.
    void _fn;
    throw transactionsUnsupported();
  }

  createBatch(): BatchBackend {
    return new DORPCBatchBackend(() => this.stub);
  }

  // --- Subgraphs ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    validateSegment(parentNodeUid, 'parentNodeUid');
    validateSegment(name, 'subgraph name');
    const newStorageKey = `${this.storageKey}/${parentNodeUid}/${name}`;
    const newScopePath = this.scopePath ? `${this.scopePath}/${name}` : name;
    return new DORPCBackend(this.namespace, {
      table: this.collectionPath,
      scopePath: newScopePath,
      storageKey: newStorageKey,
    });
  }

  // --- Cascade & bulk ---

  async removeNodeCascade(
    uid: string,
    _reader: GraphReader,
    _options?: BulkOptions,
  ): Promise<CascadeResult> {
    // Phase 1: cascade is DO-local. The `reader` argument is unused here
    // because the DO discovers edges directly against its own SQLite. In
    // phase 2 the client wrapper will consult the registry topology to
    // enumerate subgraph-child DOs and destroy each via `_fgDestroy()`.
    void _reader;
    void _options;
    return this.stub._fgRemoveNodeCascade(uid);
  }

  async bulkRemoveEdges(
    params: FindEdgesParams,
    _reader: GraphReader,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    void _reader;
    return this.stub._fgBulkRemoveEdges(params, options);
  }

  // --- Cross-scope (phase 2) ---
  //
  // `findEdgesGlobal` is deliberately NOT defined on this class in phase 1.
  // The `StorageBackend` interface has it as optional, so the GraphClient's
  // short-circuit (`if (!this.backend.findEdgesGlobal) throw …`) fires
  // before any query planning or scan-safety checks run. Phase 2 will add
  // the method and fan out via registry topology.

  // --- Phase-2 hook: destroy this DO's storage ---

  /**
   * Wipe this DO's storage. Used by the phase-2 cascade when the client
   * topologically enumerates subgraph-child DOs and tears each down. Exposed
   * on the concrete class (not `StorageBackend`) so generic backend code
   * doesn't reach for it.
   */
  async destroy(): Promise<void> {
    await this.stub._fgDestroy();
  }
}
