/**
 * Routing `StorageBackend` wrapper.
 *
 * `createRoutingBackend(base, { route })` returns a `StorageBackend` that
 * behaves identically to `base` except for `subgraph(parentUid, name)`:
 * each such call consults the caller-supplied `route` function, and if it
 * returns a non-null `StorageBackend`, that backend is used for the child
 * scope.
 *
 * This is the single seam firegraph ships for splitting a logical graph
 * across multiple physical storage backends — e.g. fanning particular
 * subgraph names out to their own Durable Objects to stay under the 10 GB
 * per-DO limit. The routing policy itself, the RPC protocol, and any
 * live-scope index are left to the caller; firegraph only owns the
 * composition primitive and the invariants that come with it.
 *
 * ## Contract — nested routing
 *
 * Whether `route()` returns a routed backend OR `null` (pass-through), the
 * child returned by `subgraph()` is **always** itself wrapped by the same
 * router. Without that self-wrap, a call chain like
 *
 * ```ts
 * router.subgraph(A, 'memories').subgraph(B, 'context')
 * ```
 *
 * would route the first hop correctly but bypass the router on the second
 * hop (since the routed backend's own `.subgraph()` doesn't know about the
 * caller's policy). Keeping routing active through grandchildren is the
 * load-bearing behaviour; `'continues routing on grandchildren …'` in the
 * unit tests locks it in.
 *
 * ## Contract — `route` is synchronous
 *
 * `.subgraph()` is synchronous in firegraph's public API. Making the
 * routing callback async would require rippling Promises through every
 * client-factory call site. Consequence: `route` can only consult data it
 * already has in hand (DO bindings, naming rules, in-memory caches). If
 * you need "does this DO exist?" checks, do them lazily — the first read
 * against the returned backend will surface the failure naturally.
 *
 * ## Contract — cross-backend atomicity is not silently degraded
 *
 * The wrapper's `runTransaction` and `createBatch` delegate to `base` —
 * they run entirely on the base backend. `TransactionBackend` and
 * `BatchBackend` deliberately have no `subgraph()` method, so user code
 * physically cannot open a routed child from inside a transaction
 * callback. Any attempt to bypass that (via `as any` / unchecked casts)
 * should surface as `CrossBackendTransactionError` so app code can catch
 * it cleanly — the error type is part of the public surface.
 *
 * ## Contract — `findEdgesGlobal` is base-scope only
 *
 * When delegated, `findEdgesGlobal` runs against the base backend only.
 * It does **not** fan out to routed children — firegraph has no
 * enumeration index for which routed backends exist. Callers who need
 * cross-shard collection-group queries must maintain their own scope
 * directory and query it directly. This keeps the common case (local
 * analytics inside one DO) fast.
 */

import { FiregraphError } from '../errors.js';
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
import type {
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
} from './backend.js';

/**
 * Context passed to a routing callback when `subgraph(parentUid, name)` is
 * called on a routed backend. All four strings describe the *child* scope
 * the caller is requesting, so the router can key its decision off whichever
 * representation is most convenient:
 *
 *   - `parentUid` / `subgraphName` — the arguments just passed to `subgraph()`.
 *   - `scopePath` — logical, names-only chain (`'memories'`, `'memories/context'`).
 *     This is what `allowedIn` patterns match against.
 *   - `storageScope` — the materialized-path form (`'A/memories'`,
 *     `'A/memories/B/context'`), suitable for use as a DO name or shard key
 *     because it's globally unique within a root graph.
 */
export interface RoutingContext {
  parentUid: string;
  subgraphName: string;
  scopePath: string;
  storageScope: string;
}

export interface RoutingBackendOptions {
  /**
   * Decide whether a `subgraph(parentUid, name)` call should route to a
   * different backend. Return the target backend to route; return `null`
   * (or `undefined`) to fall through to the wrapped base backend.
   *
   * The returned backend is itself wrapped by the same router so that
   * nested `.subgraph()` calls on the returned child continue to be
   * consulted.
   */
  route: (ctx: RoutingContext) => StorageBackend | null | undefined;
}

function assertValidSubgraphArgs(parentNodeUid: string, name: string): void {
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
}

class RoutingStorageBackend implements StorageBackend {
  readonly collectionPath: string;
  /**
   * Logical (names-only) scope path for *this* wrapper. Tracked
   * independently of `base.scopePath` because a routed backend returned by
   * `options.route()` typically represents its own physical root and has
   * no knowledge of the caller's logical chain. The wrapper is the
   * authoritative source of the logical scope for routing decisions and
   * for satisfying the `StorageBackend.scopePath` contract surfaced to
   * client code.
   */
  readonly scopePath: string;
  /**
   * Materialized-path form of `scopePath` — interleaved `<uid>/<name>`
   * pairs. Not a property on the underlying `StorageBackend` interface
   * (Firestore doesn't produce one), so we track it ourselves from
   * `.subgraph()` arguments. Root routers start with `''`.
   */
  private readonly storageScope: string;
  /**
   * Conditionally installed in the constructor — only present when the
   * wrapped base backend supports it. Declared as an optional instance
   * property (rather than a prototype method) so `typeof router.findEdgesGlobal
   * === 'function'` reflects the base's capability, matching the optional
   * shape in the `StorageBackend` interface.
   */
  findEdgesGlobal?: StorageBackend['findEdgesGlobal'];

  constructor(
    private readonly base: StorageBackend,
    private readonly options: RoutingBackendOptions,
    storageScope: string,
    logicalScopePath: string,
  ) {
    this.collectionPath = base.collectionPath;
    this.scopePath = logicalScopePath;
    this.storageScope = storageScope;
    if (base.findEdgesGlobal) {
      // We deliberately do *not* fan out across routed children: we have no
      // enumeration index for which backends exist. Callers needing
      // cross-shard collection-group queries must maintain their own index.
      this.findEdgesGlobal = (params, collectionName) =>
        base.findEdgesGlobal!(params, collectionName);
    }
  }

  // --- Pass-through reads ---

  getDoc(docId: string): Promise<StoredGraphRecord | null> {
    return this.base.getDoc(docId);
  }

  query(filters: QueryFilter[], options?: QueryOptions): Promise<StoredGraphRecord[]> {
    return this.base.query(filters, options);
  }

  // --- Pass-through writes ---

  setDoc(docId: string, record: WritableRecord): Promise<void> {
    return this.base.setDoc(docId, record);
  }

  updateDoc(docId: string, update: UpdatePayload): Promise<void> {
    return this.base.updateDoc(docId, update);
  }

  deleteDoc(docId: string): Promise<void> {
    return this.base.deleteDoc(docId);
  }

  // --- Transactions / batches run against the base backend only ---

  runTransaction<T>(fn: (tx: TransactionBackend) => Promise<T>): Promise<T> {
    // Transactions cannot span base + routed backends (different DBs /
    // DOs / Firestore projects). `TransactionBackend` has no `subgraph()`
    // method, so the user physically cannot open a routed child from
    // inside the callback — the compiler rejects it. At runtime, all
    // reads/writes are confined to the base backend.
    return this.base.runTransaction(fn);
  }

  createBatch(): BatchBackend {
    // Same constraint as transactions: `BatchBackend` has no `subgraph()`
    // so all buffered ops target the base backend. The router itself
    // doesn't need to guard anything here.
    return this.base.createBatch();
  }

  // --- Subgraphs: the only method that actually routes ---

  subgraph(parentNodeUid: string, name: string): StorageBackend {
    assertValidSubgraphArgs(parentNodeUid, name);

    const childScopePath = this.scopePath ? `${this.scopePath}/${name}` : name;
    const childStorageScope = this.storageScope
      ? `${this.storageScope}/${parentNodeUid}/${name}`
      : `${parentNodeUid}/${name}`;

    const routed = this.options.route({
      parentUid: parentNodeUid,
      subgraphName: name,
      scopePath: childScopePath,
      storageScope: childStorageScope,
    });

    if (routed) {
      // The user returned a different backend. We still wrap it so that
      // further `.subgraph()` calls on the returned child continue to
      // consult the router. The routed backend's own `scopePath` / storage
      // layout is its business — for routing purposes we carry *our*
      // logical view forward (`childScopePath`) so grandchildren see a
      // correct context regardless of what `routed.scopePath` happens to
      // be (typically `''` for a freshly-minted per-DO backend).
      return new RoutingStorageBackend(routed, this.options, childStorageScope, childScopePath);
    }

    // No route — delegate to the base backend and keep routing in effect
    // for grandchildren.
    const childBase = this.base.subgraph(parentNodeUid, name);
    return new RoutingStorageBackend(childBase, this.options, childStorageScope, childScopePath);
  }

  // --- Bulk operations: delegate, but cascade is base-scope only ---

  removeNodeCascade(
    uid: string,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<CascadeResult> {
    // `removeNodeCascade` on the base backend cannot see rows that live
    // in routed child backends — each routed backend is a different
    // physical store. Callers with routed subgraphs under `uid` are
    // responsible for cascading those themselves (see routing.md).
    return this.base.removeNodeCascade(uid, reader, options);
  }

  bulkRemoveEdges(
    params: FindEdgesParams,
    reader: GraphReader,
    options?: BulkOptions,
  ): Promise<BulkResult> {
    return this.base.bulkRemoveEdges(params, reader, options);
  }

  // --- Collection-group queries are base-scope only ---
  //
  // `findEdgesGlobal` is installed in the constructor *only* when the base
  // backend supports it, so `typeof router.findEdgesGlobal === 'function'`
  // reflects the base's capability — matching the optional shape declared
  // on `StorageBackend`.
}

/**
 * Wrap a `StorageBackend` so that `subgraph(parentUid, name)` calls can be
 * routed to a different backend based on a user-supplied callback.
 *
 * See the module docstring for the atomicity rules. In short: transactions
 * and batches opened on a routing backend run entirely on the *base*
 * backend — they cannot span routed children, by design.
 *
 * @example
 * ```ts
 * const base = createDOSqliteBackend(ctx.storage, 'fg');
 * const routed = createRoutingBackend(base, {
 *   route: ({ subgraphName, storageScope }) => {
 *     if (subgraphName !== 'memories') return null;
 *     const stub = env.MEMORIES.get(env.MEMORIES.idFromName(storageScope));
 *     return createMyRpcBackend(stub);  // caller-owned
 *   },
 * });
 * const client = createGraphClientFromBackend(routed, { registry });
 * ```
 */
export function createRoutingBackend(
  base: StorageBackend,
  options: RoutingBackendOptions,
): StorageBackend {
  if (typeof options?.route !== 'function') {
    throw new FiregraphError(
      'createRoutingBackend: `options.route` must be a function.',
      'INVALID_ARGUMENT',
    );
  }
  return new RoutingStorageBackend(base, options, '', base.scopePath);
}
