export { createGraphClient } from './client.js';
export { createRegistry } from './registry.js';
export { generateId } from './id.js';
export { computeNodeDocId, computeEdgeDocId } from './docid.js';
export { buildNodeRecord, buildEdgeRecord } from './record.js';
export { buildEdgeQueryPlan, buildNodeQueryPlan } from './query.js';
export { createTraversal } from './traverse.js';
export { defineViews } from './views.js';
export { defineConfig, resolveView } from './config.js';

export {
  FiregraphError,
  NodeNotFoundError,
  EdgeNotFoundError,
  ValidationError,
  RegistryViolationError,
  InvalidQueryError,
  TraversalError,
} from './errors.js';

export type {
  GraphRecord,
  StoredGraphRecord,
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
  HopDefinition,
  TraversalOptions,
  HopResult,
  TraversalResult,
  TraversalBuilder,
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
  ViewRule,
  ViewResolverConfig,
  ViewDefaultsConfig,
} from './config.js';
