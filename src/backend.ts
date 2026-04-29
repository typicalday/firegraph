/**
 * Public backend surface — the stable set of types and primitives for code
 * that wants to wrap, substitute, or compose `StorageBackend`s.
 *
 * Most firegraph users only touch `GraphClient`; this module is for the
 * narrower set of users who write their own storage drivers (e.g. an RPC
 * executor that tunnels a `StorageBackend` into a Durable Object) or who
 * need to route `subgraph()` calls across multiple physical backends
 * (see `createRoutingBackend`).
 *
 * Entry point: `firegraph/backend`.
 */

export { CapabilityNotSupportedError, CrossBackendTransactionError } from './errors.js';
export type {
  BackendCapabilities,
  BatchBackend,
  StorageBackend,
  TransactionBackend,
  UpdatePayload,
  WritableRecord,
  WriteMode,
} from './internal/backend.js';
export { createCapabilities, intersectCapabilities } from './internal/backend.js';
export type { RoutingBackendOptions, RoutingContext } from './internal/routing-backend.js';
export { createRoutingBackend } from './internal/routing-backend.js';
export type { DataPathOp } from './internal/write-plan.js';
export {
  DELETE_FIELD,
  deleteField,
  flattenPatch,
  isDeleteSentinel,
} from './internal/write-plan.js';
export type { StorageScopeSegment } from './scope-path.js';
export {
  appendStorageScope,
  isAncestorScopeUid,
  parseStorageScope,
  resolveAncestorScope,
} from './scope-path.js';
