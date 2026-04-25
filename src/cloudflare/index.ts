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
 * ## Capability matrix
 *
 * | Feature                      | Status                                                   |
 * | ---------------------------- | -------------------------------------------------------- |
 * | CRUD (put/get/update/remove) | ✅                                                       |
 * | Queries (`findEdges/Nodes`)  | ✅                                                       |
 * | Batches (atomic)             | ✅                                                       |
 * | Cascade (DO-local)           | ✅                                                       |
 * | Cross-subgraph cascade       | ✅ via registry `getSubgraphTopology` fan-out            |
 * | Bulk-remove-edges (DO-local) | ✅                                                       |
 * | `.subgraph()` routing        | ✅ (auto-provisioned via `namespace.idFromName`)         |
 * | Static registry              | ✅ (validation + migrations)                             |
 * | Dynamic registry             | ✅ `registryMode: { mode: 'dynamic' }`; merged mode too  |
 * | Interactive transactions     | ❌ throws `UNSUPPORTED_OPERATION` — use `batch()`        |
 * | `findEdgesGlobal()`          | ❌ throws `UNSUPPORTED_OPERATION` — no cross-DO index    |
 */

export type {
  DORPCBackendOptions,
  DurableObjectIdLike,
  FiregraphNamespace,
  FiregraphStub,
} from './backend.js';
export { DORPCBackend } from './backend.js';
export type { DOClientOptions } from './client.js';
export { createDOClient, createSiblingClient } from './client.js';
export type {
  BatchOp,
  DOSqlCursor,
  DOSqlExecutor,
  DOStorage,
  DurableObjectStateLike,
  FiregraphDOOptions,
} from './do.js';
export { FiregraphDO } from './do.js';
export type { BuildDOSchemaOptions } from './schema.js';
export { buildDOSchemaStatements } from './schema.js';

// Re-exports of Workers-safe utilities from the main entry. Importing them
// from `firegraph/cloudflare` instead of `firegraph` lets workerd-bundled
// callers stay clear of the Firestore module graph (which transitively
// pulls `gcp-metadata` → `google-logging-utils` and crashes at module
// load on workerd's `--disallow-code-generation-from-strings` runtime).
export { META_EDGE_TYPE, META_NODE_TYPE } from '../dynamic-registry.js';
export { generateId } from '../id.js';
