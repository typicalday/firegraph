/**
 * `createDOClient` — the user-facing factory for the Cloudflare DO backend.
 *
 * Given a Durable Object namespace binding and a stable root key, returns a
 * `GraphClient` that speaks to a `FiregraphDO` instance. The root key is
 * hashed via `namespace.idFromName()` to derive the DO ID, so two clients
 * instantiated with the same key always reach the same DO — that's how we
 * achieve "subgraphs are auto-provisioned" without a separate allocation
 * step. Subsequent `.subgraph(uid, name)` calls derive child DO IDs from the
 * extended key chain (`${key}/${uid}/${name}`).
 *
 * ## What's supported
 *
 * - **Static registries.** Pass `registry` and every read/write validates
 *   and migrates exactly like the Firestore/SQLite backends.
 * - **Dynamic registries.** Pass `registryMode: { mode: 'dynamic' }` and
 *   call `defineNodeType` / `defineEdgeType` / `reloadRegistry` as with
 *   any other backend. Meta-types live in the root DO by default; pass
 *   `registryMode: { mode: 'dynamic', collection: 'meta-root' }` to put
 *   them in a separately-addressed DO. Merged mode (static `registry`
 *   plus `registryMode`) is also supported.
 * - **Cross-DO cascade.** `removeNodeCascade` consults the registry's
 *   subgraph topology and wipes every descendant subgraph DO before
 *   deleting the node. Requires a registry; without one it cascades
 *   within the current DO only. Pass `{ deleteSubcollections: false }` to
 *   keep the node removal but leave every descendant DO intact (mirrors
 *   the Firestore/SQLite `bulk` option). In dynamic mode the accessor is
 *   live, so cascading a node whose subgraph topology was just added via
 *   `defineEdgeType` correctly fans out to the new descendants — **but
 *   only after a `reloadRegistry()` call**. A cascade invoked between
 *   `defineEdgeType` and `reloadRegistry` sees only the pre-define
 *   topology and silently skips newly-declared subgraphs. This is the
 *   same trade-off every dynamic-registry backend makes.
 * - **Static migrations** on registry entries (`migrations`,
 *   `migrationWriteBack`, `migrationSandbox`) run in-process on the
 *   Worker and don't cross the DO RPC boundary. The read-path migration
 *   pipeline lives in `GraphClient`, not in `FiregraphDO`.
 *
 * ## Performance note on cascade
 *
 * Cross-DO cascade instantiates (via `namespace.get`) every declared child
 * subgraph DO even when it's empty — Durable Objects have no "does this ID
 * exist" primitive, and the cheapest way to tear a DO down is to issue one
 * RPC. For a node with N declared subgraph segments, expect N+1 RPCs per
 * cascade (one per child DO wipe, one for the parent). Topology width is
 * typically small and bounded by registry size, but keep it in mind for
 * wide fan-out designs.
 *
 * ## What's not supported
 *
 * - **Interactive transactions.** Would require pinning a SQLite
 *   transaction open across async RPC calls — see `backend.ts` for the
 *   rationale. Use `batch()` for atomic multi-write commits.
 * - **`findEdgesGlobal`.** Cross-DO collection-group queries don't map
 *   onto "one DO owns one subgraph's rows" — each subgraph is a separate
 *   DO with private SQLite and there's no namespace-wide catalog. The
 *   method is intentionally undefined on the backend so `GraphClient`
 *   surfaces a generic `UNSUPPORTED_OPERATION` error immediately, before
 *   any query planning. Callers that need this should maintain an
 *   application-level index DO or run an explicit traversal via
 *   `client.subgraph(...)`.
 *
 * ## Binding example
 *
 * ```ts
 * // worker.ts
 * export { FiregraphDO } from '@typicalday/firegraph/cloudflare';
 *
 * export default {
 *   async fetch(req: Request, env: Env) {
 *     const client = createDOClient(env.GRAPH, 'main', { registry });
 *     const project = await client.getNode('project', projectUid);
 *     return Response.json(project);
 *   },
 * };
 * ```
 *
 * ```toml
 * # wrangler.toml
 * [[durable_objects.bindings]]
 * name = "GRAPH"
 * class_name = "FiregraphDO"
 *
 * [[migrations]]
 * tag = "v1"
 * new_sqlite_classes = ["FiregraphDO"]
 * ```
 */

import type { GraphClientImpl } from '../client.js';
import { createGraphClientFromBackend } from '../client.js';
import { FiregraphError } from '../errors.js';
import type { StorageBackend } from '../internal/backend.js';
import type {
  DynamicGraphClient,
  DynamicRegistryConfig,
  GraphClient,
  GraphClientOptions,
  GraphRegistry,
} from '../types.js';
import type { FiregraphNamespace } from './backend.js';
import { DORPCBackend } from './backend.js';

export interface DOClientOptions extends GraphClientOptions {
  /**
   * Logical table label — informational only, surfaced as
   * `backend.collectionPath`. The DO's actual table name is chosen on the
   * DO side (see `FiregraphDOOptions.table`) and defaults to `'firegraph'`;
   * the two must agree if the user overrides the DO's table.
   */
  table?: string;
}

/**
 * Create a `GraphClient` backed by a `FiregraphDO` Durable Object.
 *
 * @param namespace  The DO namespace binding (`env.GRAPH` in Worker code).
 * @param rootKey    Stable name for the root graph's DO. The same value
 *                   always addresses the same DO — treat it as the graph's
 *                   identity. Subgraph DOs derive their names from this.
 * @param options    Optional `GraphClientOptions` (registry, query mode,
 *                   `registryMode` for dynamic registries, etc.).
 *                   When `registryMode` is set the return type is
 *                   narrowed to `DynamicGraphClient`.
 */
export function createDOClient(
  namespace: FiregraphNamespace,
  rootKey: string,
  options: DOClientOptions & { registryMode: DynamicRegistryConfig },
): DynamicGraphClient;
export function createDOClient(
  namespace: FiregraphNamespace,
  rootKey: string,
  options?: DOClientOptions,
): GraphClient;
export function createDOClient(
  namespace: FiregraphNamespace,
  rootKey: string,
  options: DOClientOptions = {},
): GraphClient | DynamicGraphClient {
  if (!rootKey || typeof rootKey !== 'string') {
    throw new FiregraphError(
      `createDOClient: rootKey must be a non-empty string, got ${JSON.stringify(rootKey)}.`,
      'INVALID_ARGUMENT',
    );
  }
  if (rootKey.includes('/')) {
    // Subgraph chaining builds keys as `${rootKey}/${uid}/${name}`; a slash in
    // the root would make `${rootA}/uid/x` collide with `${rootB}/uid/x` if
    // `rootB === rootA + '/…'`. Keep the root a single opaque segment.
    throw new FiregraphError(
      `createDOClient: rootKey must not contain "/". Got: "${rootKey}".`,
      'INVALID_ARGUMENT',
    );
  }

  const { table, ...clientOptions } = options;
  const collectionLabel = table ?? 'firegraph';

  // Forward-reference the client so the backend's registry accessor sees
  // whatever registry the client currently holds — including late updates
  // from `reloadRegistry()` in dynamic mode. The closure is invoked lazily
  // (only during `removeNodeCascade`) by design; any synchronous invocation
  // before `client` is assigned is a programming error in this module, not
  // a user-facing scenario — hence the throw rather than a silent
  // `undefined` return.
  let client: GraphClient | DynamicGraphClient | undefined;
  const registryAccessor = (): GraphRegistry | undefined => {
    if (!client) {
      throw new FiregraphError(
        'createDOClient: registryAccessor fired before the client was assigned. ' +
          'This indicates a programming error in the DO backend — the accessor must ' +
          'only be invoked lazily from `removeNodeCascade`, never synchronously from ' +
          'the `DORPCBackend` constructor.',
        'INTERNAL',
      );
    }
    // `getRegistrySnapshot` is declared `@internal` on `GraphClientImpl`
    // and is not part of the public `GraphClient` interface. We cast
    // through `GraphClientImpl` so the call is type-checked; consumers
    // using a custom client wrapper would need to surface the same
    // accessor themselves.
    return (client as unknown as GraphClientImpl).getRegistrySnapshot();
  };

  const backend = new DORPCBackend(namespace, {
    table: collectionLabel,
    scopePath: '',
    storageKey: rootKey,
    registryAccessor,
  });

  // Dynamic registry with an explicit meta-collection → spin up a second
  // DO for meta-types. By default (no `collection`, or `collection ===
  // rootKey`) meta-nodes live in the same DO as domain data; that's the
  // simpler bootstrap and avoids an extra DO when the caller doesn't need
  // the isolation.
  let metaBackend: StorageBackend | undefined;
  if (clientOptions.registryMode?.collection) {
    const metaKey = clientOptions.registryMode.collection;
    if (metaKey.includes('/')) {
      throw new FiregraphError(
        `createDOClient: registryMode.collection must not contain "/". Got: "${metaKey}".`,
        'INVALID_ARGUMENT',
      );
    }
    if (metaKey !== rootKey) {
      metaBackend = new DORPCBackend(namespace, {
        table: collectionLabel,
        scopePath: '',
        storageKey: metaKey,
        // Meta backend shares the accessor so its own `removeNodeCascade`
        // (unlikely, but safe) would also see the live registry.
        registryAccessor,
      });
    }
  }

  client = createGraphClientFromBackend(backend, clientOptions, metaBackend);
  return client;
}
