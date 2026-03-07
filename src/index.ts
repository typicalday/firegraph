export { createGraphClient } from './client.js';
export { createRegistry } from './registry.js';
export {
  createRegistryFromGraph,
  createBootstrapRegistry,
  generateDeterministicUid,
  META_NODE_TYPE,
  META_EDGE_TYPE,
  NODE_TYPE_SCHEMA,
  EDGE_TYPE_SCHEMA,
  BOOTSTRAP_ENTRIES,
} from './dynamic-registry.js';
export { generateId } from './id.js';
export { computeNodeDocId, computeEdgeDocId } from './docid.js';
export { buildNodeRecord, buildEdgeRecord } from './record.js';
export { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
export { createTraversal } from './traverse.js';
export { defineViews } from './views.js';
export { defineConfig, resolveView } from './config.js';
export { discoverEntities } from './discover.js';
export { compileSchema, jsonSchemaToFieldMeta } from './json-schema.js';

export {
  FiregraphError,
  NodeNotFoundError,
  EdgeNotFoundError,
  ValidationError,
  RegistryViolationError,
  InvalidQueryError,
  TraversalError,
  DynamicRegistryError,
} from './errors.js';

export { DiscoveryError } from './discover.js';

export type {
  GraphRecord,
  StoredGraphRecord,
  WhereClause,
  FindEdgesParams,
  FindNodesParams,
  QueryPlan,
  QueryFilter,
  QueryOptions,
  RegistryEntry,
  GraphClientOptions,
  GraphRegistry,
  GraphReader,
  GraphWriter,
  GraphClient,
  GraphTransaction,
  GraphBatch,
  DynamicGraphClient,
  DynamicRegistryConfig,
  NodeTypeData,
  EdgeTypeData,
  HopDefinition,
  TraversalOptions,
  HopResult,
  TraversalResult,
  TraversalBuilder,
  EdgeTopology,
  DiscoveredEntity,
  DiscoveryResult,
  BulkOptions,
  BulkProgress,
  BulkResult,
  BulkBatchError,
  CascadeResult,
  QueryMode,
} from './types.js';

export type {
  ViewComponentClass,
  EntityViewConfig,
  ViewRegistryInput,
  ViewMeta,
  EntityViewMeta,
  ViewRegistry,
} from './views.js';

export type {
  FiregraphConfig,
  ViewContext,
  ViewResolverConfig,
  ViewDefaultsConfig,
} from './config.js';

export type { FieldMeta } from './json-schema.js';

export type { DiscoveryWarning, DiscoverResult } from './discover.js';

export { generateTypes } from './codegen/index.js';
export type { CodegenOptions } from './codegen/index.js';

export { QueryClient, QueryClientError } from './query-client/index.js';
export type { QueryClientErrorCode, QueryClientOptions } from './query-client/index.js';
