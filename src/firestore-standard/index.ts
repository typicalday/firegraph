/**
 * Public entry point for the Firestore Standard edition backend.
 *
 * Use this subpath when targeting standard (non-Enterprise) Firestore. It
 * does not pull in Pipeline code or any Enterprise-only features.
 */

export { createGraphClient } from '../client.js';
export { META_EDGE_TYPE, META_NODE_TYPE } from '../dynamic-registry.js';
export { generateId } from '../id.js';
export { createMergedRegistry, createRegistry } from '../registry.js';
export type { FirestoreStandardCapability, FirestoreStandardOptions } from './backend.js';
export { createFirestoreStandardBackend } from './backend.js';
