/**
 * Public entry point for the Firestore Enterprise edition backend.
 *
 * Use this subpath when targeting Enterprise Firestore. It wires the
 * Pipeline query engine alongside the classic Query API for transactions
 * and doc-level operations. Enterprise-only capabilities (full-text search,
 * geo, joins, DML, vector) are layered in by Phases 4-10 of the capability
 * refactor.
 */

export { createGraphClient } from '../client.js';
export { META_EDGE_TYPE, META_NODE_TYPE } from '../dynamic-registry.js';
export { generateId } from '../id.js';
export { createMergedRegistry, createRegistry } from '../registry.js';
export type {
  FirestoreEnterpriseBackend,
  FirestoreEnterpriseCapability,
  FirestoreEnterpriseOptions,
  FirestoreEnterpriseQueryMode,
} from './backend.js';
export { createFirestoreEnterpriseBackend } from './backend.js';
