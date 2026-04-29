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
// DML types (Phase 5, `query.dml`). Re-exported here so backend authors
// implementing the optional `StorageBackend.bulkDelete` / `bulkUpdate`
// signatures can pull `BulkUpdatePatch` from the same entry that surfaces
// `StorageBackend` itself, instead of having to reach into the root
// `firegraph` package. `DmlExtension` is the client-surface counterpart;
// it's bundled here so `intersectCapabilities` consumers building a
// composed type can name both in one place.
export type { BulkUpdatePatch, DmlExtension } from './types.js';
// Join types (Phase 6, `query.join`). Same rationale as the DML re-exports:
// backend authors implementing the optional `StorageBackend.expand` signature
// can pull `ExpandParams` / `ExpandResult` from this entry directly.
// `JoinExtension` is the client-surface counterpart, bundled here so a
// composed cap-typed client can name all three in one place.
export type { ExpandParams, ExpandResult, JoinExtension } from './types.js';
