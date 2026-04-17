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
 * ## Phase 1 scope
 *
 * This phase supports static registries only. Passing `registryMode` throws —
 * dynamic registry support will land in phase 2 alongside the registry-driven
 * topology cascade. A user with a static `registry` object can use every
 * feature of the DO backend today except interactive transactions and
 * `findEdgesGlobal`, both of which also throw `UNSUPPORTED_OPERATION`
 * (see `backend.ts` for the rationale).
 *
 * Static migrations on registry entries (`migrations`, `migrationWriteBack`,
 * `migrationSandbox`) are supported — they run in-process on the Worker and
 * don't cross the DO RPC boundary. The read-path migration pipeline lives in
 * `GraphClient`, not in `FiregraphDO`.
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

import { createGraphClientFromBackend } from '../client.js';
import { FiregraphError } from '../errors.js';
import type { GraphClient, GraphClientOptions } from '../types.js';
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
 * @param options    Optional `GraphClientOptions` (registry, query mode, etc.).
 *                   Phase 1: passing `registryMode` throws.
 */
export function createDOClient(
  namespace: FiregraphNamespace,
  rootKey: string,
  options: DOClientOptions = {},
): GraphClient {
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

  if (options.registryMode) {
    throw new FiregraphError(
      'createDOClient: `registryMode` (dynamic registry) is not supported by the Cloudflare DO ' +
        'backend in phase 1. Use a static `registry` created via `createRegistry(...)` for now. ' +
        'Dynamic registry support lands in phase 2 alongside registry-driven topology cascade.',
      'UNSUPPORTED_OPERATION',
    );
  }

  const { table, ...clientOptions } = options;
  const backend = new DORPCBackend(namespace, {
    table: table ?? 'firegraph',
    scopePath: '',
    storageKey: rootKey,
  });

  // Phase 1: no meta backend — static registry only. The `createGraphClientFromBackend`
  // overload without a third argument returns `GraphClient` (not `DynamicGraphClient`).
  return createGraphClientFromBackend(backend, clientOptions) as GraphClient;
}
