export interface NodeType {
  type: string;
  description?: string;
  titleField?: string;
  subtitleField?: string;
  isDynamic?: boolean;
}

export interface EdgeType {
  aType: string;
  axbType: string;
  bType: string;
  description?: string;
  inverseLabel?: string;
  titleField?: string;
  subtitleField?: string;
  isDynamic?: boolean;
  targetGraph?: string;
}

export interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'unknown';
  required: boolean;
  description?: string;
  enumValues?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  isInt?: boolean;
  itemMeta?: FieldMeta;
  fields?: FieldMeta[];
}

export interface RegistryEntryMeta {
  aType: string;
  axbType: string;
  bType: string;
  description?: string;
  inverseLabel?: string;
  titleField?: string;
  subtitleField?: string;
  hasDataSchema: boolean;
  fields: FieldMeta[];
  isNodeEntry: boolean;
  isDynamic?: boolean;
  targetGraph?: string;
  allowedIn?: string[];
}

export interface CollectionDef {
  name: string;
  /** Raw path template, e.g. "graph/{nodeUid}/logs" */
  path: string;
  description?: string;
  typeField?: string;
  typeValue?: string | number | boolean;
  parentNodeType?: string;
  fields: FieldMeta[];
  hasSchema: boolean;
  pathParams: string[];
  defaultOrderBy?: { field: string; direction: 'asc' | 'desc' };
}

export interface Schema {
  nodeTypes: NodeType[];
  edgeTypes: EdgeType[];
  readonly: boolean;
  nodeSchemas?: RegistryEntryMeta[];
  edgeSchemas?: RegistryEntryMeta[];
  dynamicMode?: boolean;
  collections?: CollectionDef[];
}

export interface GraphRecord {
  aType: string;
  aUid: string;
  axbType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  _matchType?: string;
}

export interface NodeDetailData {
  node: GraphRecord | null;
  outEdges: GraphRecord[];
  inEdges: GraphRecord[];
}

export interface WhereClause {
  field: string;
  op: '==' | '!=' | '<' | '<=' | '>' | '>=';
  value: string | number | boolean;
}

export interface HopDef {
  axbType: string;
  direction: 'forward' | 'reverse';
  limit: number;
  aType?: string;
  bType?: string;
  orderBy?: { field: string; direction: 'asc' | 'desc' };
  where?: WhereClause[];
}

export interface HopResult {
  axbType: string;
  direction: string;
  depth: number;
  edges: GraphRecord[];
  sourceCount: number;
  truncated: boolean;
}

export interface TraversalResult {
  nodes: GraphRecord[];
  hops: HopResult[];
  totalReads: number;
  truncated: boolean;
}

export interface AppConfig {
  projectId: string;
  collection: string;
  readonly: boolean;
  viewDefaults?: ViewDefaultsConfig | null;
  chatEnabled?: boolean;
  chatModel?: string;
}

// --- View resolution types (mirrors src/config.ts for client use) ---

/** Display contexts where views can appear. */
export type ViewContext = 'listing' | 'detail' | 'inline';

export interface ViewResolverConfig {
  default?: string;
  listing?: string;
  detail?: string;
  inline?: string;
}

export interface ViewDefaultsConfig {
  nodes?: Record<string, ViewResolverConfig>;
  edges?: Record<string, ViewResolverConfig>;
}

// --- View types ---

export interface ViewMeta {
  tagName: string;
  viewName: string;
  description?: string;
}

export interface EntityViewMeta {
  views: ViewMeta[];
  sampleData?: Record<string, unknown>;
}

export interface ViewRegistryData {
  nodes: Record<string, EntityViewMeta>;
  edges: Record<string, EntityViewMeta>;
  collections: Record<string, EntityViewMeta>;
  hasViews: boolean;
}

// --- Schema/views validation warnings ---

export interface SchemaViewWarning {
  code: string;
  severity: 'warn' | 'info';
  message: string;
  entityType: string;
  entityKind: 'node' | 'edge';
  viewName?: string;
}
