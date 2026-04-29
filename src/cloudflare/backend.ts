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
 * - Interactive transactions throw `UNSUPPORTED_OPERATION` — holding a
 *   synchronous SQLite transaction across async RPC calls would block the
 *   DO's single-threaded executor (see `transactionsUnsupported` below).
 * - `findEdgesGlobal` is deliberately left undefined on this class. The
 *   `GraphClient` surfaces the generic "not supported by current storage
 *   backend" error before running any query planning, which is both
 *   accurate and sidesteps the misleading `QuerySafetyError` that would
 *   otherwise fire for scan-unsafe calls. `createDOClient`'s docstring
 *   explains the design rationale (no collection-group index across DOs).
 * - `removeNodeCascade` cascades across DOs: when a registry accessor is
 *   wired, the backend walks `registry.getSubgraphTopology(aType)` for the
 *   node being removed and destroys every descendant subgraph DO before
 *   deleting the node itself. Pass `{ deleteSubcollections: false }` to
 *   disable the cross-DO fan-out (parent node is still removed, child DOs
 *   are left intact — matching the Firestore/SQLite backends' semantic).
 *   Without an accessor (e.g. registry-less clients) it cascades within
 *   the current DO only.
 */

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
import type {
  BulkOptions,
  BulkResult,
  Capability,
  CascadeResult,
  DynamicGraphClient,
  FindEdgesParams,
  GraphClient,
  GraphReader,
  GraphRegistry,
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
  _fgSetDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void>;
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
// Transaction backend — always throws
// ---------------------------------------------------------------------------

/**
 * Interactive transactions across DO RPC would require holding a synchronous
 * SQLite transaction open across multiple async RPC round-trips, which blocks
 * the DO's single-threaded executor for the duration. That's incompatible
 * with the runtime's fairness model, so this backend refuses `runTransaction`
 * outright. Callers should either restructure read-then-conditional-write
 * logic as an explicit `read → decide → batch` sequence, or use `batch()`
 * for atomic multi-write patterns.
 */
function transactionsUnsupported(): FiregraphError {
  return new FiregraphError(
    'Interactive transactions are not supported by the Cloudflare DO backend. ' +
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

  setDoc(docId: string, record: WritableRecord, mode: WriteMode): void {
    this.ops.push({ kind: 'set', docId, record, mode });
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
  /** Scope path (names-only chain, used for `allowedIn`). Default: `''`. */
  scopePath?: string;
  /**
   * Opaque storage key used to derive the DO instance via
   * `namespace.idFromName(storageKey)`. Defaults to the root key passed to
   * `createDOClient` when the backend is first created.
   */
  storageKey: string;
  /**
   * Live registry accessor used by `removeNodeCascade` to consult the
   * subgraph topology and fan out `_fgDestroy` calls to child subgraph DOs.
   *
   * A function (not a snapshot) so that dynamic-registry clients see the
   * latest definitions after `reloadRegistry()`. Wired by `createDOClient`
   * via a forward reference to the constructed `GraphClient`. When
   * `undefined`, cross-DO cascade is disabled and `removeNodeCascade`
   * cascades within this DO only.
   * @internal
   */
  registryAccessor?: () => GraphRegistry | undefined;
  /**
   * Factory used by `createSiblingClient` to construct a peer `GraphClient`
   * that shares this client's namespace, registry, and other options but
   * targets a different root DO. Wired by `createDOClient`. Leaving it
   * `undefined` (e.g. when `DORPCBackend` is instantiated directly) disables
   * sibling-client construction — `createSiblingClient` will throw.
   *
   * The union return type mirrors `createDOClient`'s two overloads: dynamic
   * mode yields a `DynamicGraphClient`, everything else yields a plain
   * `GraphClient`. `createSiblingClient` narrows at the boundary via its
   * own overload signatures.
   * @internal
   */
  makeSiblingClient?: (siblingStorageKey: string) => GraphClient | DynamicGraphClient;
}

/**
 * Capabilities the DO RPC backend declares.
 *
 * Note the absence of `core.transactions`: `runTransaction` throws
 * `UNSUPPORTED_OPERATION` because holding a synchronous SQLite transaction
 * across async RPC calls would block the DO's single-threaded executor (see
 * `transactionsUnsupported` above). `raw.sql` is also intentionally absent —
 * the SQL surface lives inside the DO and isn't exposed across the RPC
 * boundary.
 */
const DO_CAPS: ReadonlySet<Capability> = new Set<Capability>([
  'core.read',
  'core.write',
  'core.batch',
  'core.subgraph',
]);

export class DORPCBackend implements StorageBackend {
  readonly capabilities: BackendCapabilities = createCapabilities(DO_CAPS);
  readonly collectionPath = 'firegraph';
  readonly scopePath: string;
  /** @internal */
  readonly storageKey: string;
  /** @internal */
  readonly namespace: FiregraphNamespace;
  private readonly registryAccessor?: () => GraphRegistry | undefined;
  /** @internal — see `DORPCBackendOptions.makeSiblingClient` for the union-type rationale. */
  readonly makeSiblingClient?: (siblingStorageKey: string) => GraphClient | DynamicGraphClient;
  private cachedStub: FiregraphStub | null = null;

  constructor(namespace: FiregraphNamespace, options: DORPCBackendOptions) {
    this.namespace = namespace;
    this.scopePath = options.scopePath ?? '';
    this.storageKey = options.storageKey;
    this.registryAccessor = options.registryAccessor;
    this.makeSiblingClient = options.makeSiblingClient;
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

  async setDoc(docId: string, record: WritableRecord, mode: WriteMode): Promise<void> {
    return this.stub._fgSetDoc(docId, record, mode);
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
      scopePath: newScopePath,
      storageKey: newStorageKey,
      // Subgraph backends share the same live registry accessor so a cascade
      // invoked on a subgraph client still fans out correctly. The sibling
      // factory is also carried forward so `createSiblingClient` works from
      // any subgraph client in the chain.
      registryAccessor: this.registryAccessor,
      makeSiblingClient: this.makeSiblingClient,
    });
  }

  // --- Cascade & bulk ---

  async removeNodeCascade(
    uid: string,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<CascadeResult> {
    // Cross-DO cascade. When a registry is wired and the caller wants
    // subcollections (the default, `deleteSubcollections !== false`), walk
    // the subgraph topology for this node's type and wipe every descendant
    // DO before deleting the node itself. This mirrors the Firestore and
    // SQLite backends, which honor the same flag to recurse into nested
    // subgraphs. Without an accessor we fall back to DO-local cascade only
    // — each DO owns its own scope, and registry-less clients have no way
    // to discover descendants.
    //
    // We need the node's aType to know what subgraphs to look for. That
    // means a `getNode` round-trip before touching any child DO; the reader
    // is the client that owns this backend, so the round-trip hits *this*
    // DO and stays cheap. If the node doesn't exist there's nothing to
    // cascade across — skip straight to the local cascade, which will
    // report `nodeDeleted: false`.
    const shouldDeleteSubgraphs = options?.deleteSubcollections !== false;
    const registry = this.registryAccessor?.();
    if (shouldDeleteSubgraphs && registry) {
      const node = await reader.getNode(uid);
      if (node) {
        const topology = registry.getSubgraphTopology(node.aType);
        for (const entry of topology) {
          // `getSubgraphTopology` only returns entries with a `targetGraph`.
          // The non-null assertion encodes that invariant — a missing value
          // here is a registry-construction bug, not a runtime data issue.
          const target = entry.targetGraph!;
          const childBackend = this.subgraph(uid, target) as DORPCBackend;
          await childBackend.destroyRecursively(registry);
        }
      }
    }
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

  // --- Cross-scope queries ---
  //
  // `findEdgesGlobal` is deliberately NOT defined on this class. The
  // GraphClient checks for its presence before running query planning and
  // throws `UNSUPPORTED_OPERATION` when absent, giving the caller an
  // immediate, accurate error. Defining the method with a throwing body
  // would only surface the same error AFTER `checkQuerySafety` had already
  // fired — and for scan-unsafe calls that results in a misleading
  // `QuerySafetyError` ("add filters like aUid+axbType") when no filter
  // combination would actually make the call work on this backend. See the
  // "What's not supported" section in `createDOClient` for the design
  // rationale (no collection-group index across DOs).

  // --- Destroy helpers ---

  /**
   * Wipe this DO's storage. The DO itself can't be deleted — its ID
   * persists forever — but its rows can be emptied, which is what the
   * cascade walk does on every descendant subgraph DO.
   *
   * Exposed on the concrete class (not `StorageBackend`) so generic
   * backend code doesn't reach for it.
   */
  async destroy(): Promise<void> {
    await this.stub._fgDestroy();
  }

  /**
   * Tear down every descendant subgraph DO, then wipe this DO's own rows.
   *
   * Invoked by cross-DO cascade: for each node in this DO we enumerate the
   * subgraph topology and recurse into child DOs depth-first before
   * wiping the current DO. The current DO's own rows are destroyed last so
   * that a partial failure mid-recursion leaves the caller's reader able
   * to discover what's still present.
   *
   * @internal
   */
  async destroyRecursively(registry: GraphRegistry): Promise<void> {
    // Enumerate every node (self-loop) in this DO. We only need nodes —
    // edges don't own subgraph children, only nodes do.
    const nodes = await this.query([{ field: 'axbType', op: '==', value: NODE_RELATION }]);
    for (const node of nodes) {
      const topology = registry.getSubgraphTopology(node.aType);
      for (const entry of topology) {
        // `getSubgraphTopology` only returns entries with a `targetGraph` —
        // see the matching assertion in `removeNodeCascade` above.
        const target = entry.targetGraph!;
        const childBackend = this.subgraph(node.aUid, target) as DORPCBackend;
        await childBackend.destroyRecursively(registry);
      }
    }
    await this.destroy();
  }
}
