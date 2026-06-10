/**
 * Public entry point for the table-per-graph SQLite backend.
 *
 * Use this subpath when targeting better-sqlite3, libSQL, D1, or any other
 * SQLite-compatible driver via the `SqliteExecutor` interface. Each graph
 * (root and every subgraph) lives in its own table — there is no `scope`
 * column — and a small catalog table tracks the graph → table mapping. The
 * write pipeline is shared with the Cloudflare Durable Object backend.
 *
 * For local SQLite files via better-sqlite3, use `firegraph/sqlite-local`
 * (`createLocalSqliteBackend`) — kept out of this barrel so D1 / workerd
 * bundles never reference the native dependency.
 */

export { createGraphClient } from '../client.js';
export { META_EDGE_TYPE, META_NODE_TYPE } from '../dynamic-registry.js';
export { generateId } from '../id.js';
export { createMergedRegistry, createRegistry } from '../registry.js';
export type { SqliteBackendOptions, SqliteCapability } from './backend.js';
export { createSqliteBackend } from './backend.js';
