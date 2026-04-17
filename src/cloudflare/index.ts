/**
 * Public entry point for firegraph's Cloudflare-native backend.
 *
 * Everything re-exported here lives at `@typicalday/firegraph/cloudflare`.
 * The design philosophy — one Durable Object per subgraph, no scope column,
 * physical isolation — is documented in `do.ts` and `backend.ts`.
 *
 * ## Typical worker wiring
 *
 * ```ts
 * // worker.ts
 * export { FiregraphDO } from '@typicalday/firegraph/cloudflare';
 *
 * import { createDOClient } from '@typicalday/firegraph/cloudflare';
 * import { registry } from './registry.js';
 *
 * export default {
 *   async fetch(_req: Request, env: { GRAPH: DurableObjectNamespace }) {
 *     const client = createDOClient(env.GRAPH, 'main', { registry });
 *     // … use client as a normal firegraph GraphClient …
 *   },
 * };
 * ```
 *
 * ## Phase 1 capability matrix
 *
 * | Feature                      | Status                                            |
 * | ---------------------------- | ------------------------------------------------- |
 * | CRUD (put/get/update/remove) | ✅                                                |
 * | Queries (`findEdges/Nodes`)  | ✅                                                |
 * | Batches (atomic)             | ✅                                                |
 * | Cascade (DO-local)           | ✅                                                |
 * | Bulk-remove-edges (DO-local) | ✅                                                |
 * | `.subgraph()` routing        | ✅ (auto-provisioned via `namespace.idFromName`)  |
 * | Interactive transactions     | ❌ throws `UNSUPPORTED_OPERATION`                 |
 * | `findEdgesGlobal()`          | ❌ throws `UNSUPPORTED_OPERATION`                 |
 * | Cross-subgraph cascade       | ❌ phase 2 (registry topology)                    |
 * | Dynamic registry             | ❌ phase 2                                        |
 */

export type {
  DORPCBackendOptions,
  DurableObjectIdLike,
  FiregraphNamespace,
  FiregraphStub,
} from './backend.js';
export { DORPCBackend } from './backend.js';
export type { DOClientOptions } from './client.js';
export { createDOClient } from './client.js';
export type {
  BatchOp,
  DOSqlCursor,
  DOSqlExecutor,
  DOStorage,
  DurableObjectStateLike,
  FiregraphDOOptions,
} from './do.js';
export { FiregraphDO } from './do.js';
