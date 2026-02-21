export interface NodeType {
  type: string;
  description?: string;
}

export interface EdgeType {
  aType: string;
  abType: string;
  bType: string;
  description?: string;
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
  abType: string;
  bType: string;
  description?: string;
  hasDataSchema: boolean;
  fields: FieldMeta[];
  isNodeEntry: boolean;
}

export interface Schema {
  nodeTypes: NodeType[];
  edgeTypes: EdgeType[];
  readonly: boolean;
  nodeSchemas?: RegistryEntryMeta[];
  edgeSchemas?: RegistryEntryMeta[];
}

export interface GraphRecord {
  aType: string;
  aUid: string;
  abType: string;
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

export interface HopDef {
  abType: string;
  direction: 'forward' | 'reverse';
  limit: number;
  aType?: string;
  bType?: string;
}

export interface HopResult {
  abType: string;
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
}
