export { createGraphClient, createGraphClientFromBackend } from './client.js';
export type { CodegenOptions } from './codegen/index.js';
export { generateTypes } from './codegen/index.js';
export type {
  FiregraphConfig,
  ViewContext,
  ViewDefaultsConfig,
  ViewResolverConfig,
} from './config.js';
export { defineConfig, resolveView } from './config.js';
export { isAncestorUid, resolveAncestorCollection } from './cross-graph.js';
export { DEFAULT_CORE_INDEXES } from './default-indexes.js';
export type { DiscoverResult, DiscoveryWarning } from './discover.js';
export { discoverEntities } from './discover.js';
export { DiscoveryError } from './discover.js';
export { computeEdgeDocId, computeNodeDocId } from './docid.js';
export {
  BOOTSTRAP_ENTRIES,
  createBootstrapRegistry,
  createRegistryFromGraph,
  EDGE_TYPE_SCHEMA,
  generateDeterministicUid,
  META_EDGE_TYPE,
  META_NODE_TYPE,
  NODE_TYPE_SCHEMA,
} from './dynamic-registry.js';
export {
  CapabilityNotSupportedError,
  CrossBackendTransactionError,
  DynamicRegistryError,
  EdgeNotFoundError,
  FiregraphError,
  InvalidQueryError,
  MigrationError,
  NodeNotFoundError,
  QuerySafetyError,
  RegistryScopeError,
  RegistryViolationError,
  TraversalError,
  ValidationError,
} from './errors.js';
export { generateId } from './id.js';
export type {
  FirestoreIndex,
  FirestoreIndexConfig,
  FirestoreIndexField,
  GenerateIndexOptions,
} from './indexes.js';
export { generateIndexConfig } from './indexes.js';
export { DEFAULT_QUERY_LIMIT } from './internal/constants.js';
export { deleteField } from './internal/write-plan.js';
export type { FieldMeta } from './json-schema.js';
export { compileSchema, jsonSchemaToFieldMeta } from './json-schema.js';
export type { MigrationResult } from './migration.js';
export {
  applyMigrationChain,
  migrateRecord,
  migrateRecords,
  validateMigrationChain,
} from './migration.js';
export { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
export type { QueryClientErrorCode, QueryClientOptions } from './query-client/index.js';
export { QueryClient, QueryClientError } from './query-client/index.js';
export type { QuerySafetyResult } from './query-safety.js';
export { analyzeQuerySafety } from './query-safety.js';
export { createMergedRegistry, createRegistry } from './registry.js';
export {
  compileMigrationFn,
  compileMigrations,
  defaultExecutor,
  destroySandboxWorker,
  precompileSource,
} from './sandbox.js';
export { matchScope, matchScopeAny } from './scope.js';
export type { StorageScopeSegment } from './scope-path.js';
export {
  appendStorageScope,
  isAncestorScopeUid,
  parseStorageScope,
  resolveAncestorScope,
} from './scope-path.js';
export {
  deserializeFirestoreTypes,
  isTaggedValue,
  SERIALIZATION_TAG,
  serializeFirestoreTypes,
} from './serialization.js';
export { createTraversal } from './traverse.js';
export type {
  AggregateExtension,
  AggregateField,
  AggregateOp,
  AggregateResult,
  AggregateSpec,
  BulkBatchError,
  BulkOptions,
  BulkProgress,
  BulkResult,
  BulkUpdatePatch,
  Capability,
  CascadeResult,
  CoreGraphClient,
  DefineTypeOptions,
  DiscoveredEntity,
  DiscoveryResult,
  DistanceMeasure,
  DmlExtension,
  DynamicGraphClient,
  DynamicGraphMethods,
  DynamicRegistryConfig,
  EdgeTopology,
  EdgeTypeData,
  ExpandParams,
  ExpandResult,
  FindEdgesParams,
  FindEdgesProjectedParams,
  FindNearestParams,
  FindNodesParams,
  FullTextSearchExtension,
  GeoExtension,
  GraphBatch,
  GraphClient,
  GraphClientOptions,
  GraphReader,
  GraphRecord,
  GraphRegistry,
  GraphTransaction,
  GraphWriter,
  HopDefinition,
  HopResult,
  IndexFieldSpec,
  IndexSpec,
  JoinExtension,
  MigrationExecutor,
  MigrationFn,
  MigrationStep,
  MigrationWriteBack,
  NodeTypeData,
  ProjectedRow,
  QueryFilter,
  QueryMode,
  QueryOptions,
  QueryPlan,
  RawFirestoreExtension,
  RawSqlExtension,
  RealtimeListenExtension,
  RegistryEntry,
  ScanProtection,
  SelectExtension,
  StoredGraphRecord,
  StoredMigrationStep,
  TraversalBuilder,
  TraversalOptions,
  TraversalResult,
  VectorExtension,
  WhereClause,
} from './types.js';
export type {
  EntityViewConfig,
  EntityViewMeta,
  ViewComponentClass,
  ViewMeta,
  ViewRegistry,
  ViewRegistryInput,
} from './views.js';
export { defineViews } from './views.js';
