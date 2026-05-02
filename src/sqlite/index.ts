/**
 * Public entry point for the shared-table SQLite backend.
 *
 * Use this subpath when targeting better-sqlite3, libSQL, D1, or any other
 * SQLite-compatible driver via the `SqliteExecutor` interface. The backend
 * encodes subgraphs as a materialized `scope` column and shares its write
 * pipeline with the Cloudflare Durable Object backend.
 */

export { createGraphClient } from '../client.js';
export { META_EDGE_TYPE, META_NODE_TYPE } from '../dynamic-registry.js';
export { generateId } from '../id.js';
export { createMergedRegistry, createRegistry } from '../registry.js';
export type { SqliteBackendOptions, SqliteCapability } from './backend.js';
export { createSqliteBackend } from './backend.js';
