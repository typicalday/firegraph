import type { Timestamp, FieldValue, WhereFilterOp } from 'firebase-admin/firestore';

export interface GraphRecord {
  aType: string;
  aUid: string;
  abType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

export interface StoredGraphRecord {
  aType: string;
  aUid: string;
  abType: string;
  bType: string;
  bUid: string;
  data: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FindEdgesParams {
  aType?: string;
  aUid?: string;
  abType?: string;
  bType?: string;
  bUid?: string;
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
}

export interface FindNodesParams {
  aType: string;
}

export interface QueryOptions {
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
}

export type QueryPlan =
  | { strategy: 'get'; docId: string }
  | { strategy: 'query'; filters: QueryFilter[]; options?: QueryOptions };

export interface QueryFilter {
  field: string;
  op: WhereFilterOp;
  value: string;
}

export interface RegistryEntry {
  aType: string;
  abType: string;
  bType: string;
  dataSchema?: { parse: (data: unknown) => unknown };
  description?: string;
}

export interface GraphClientOptions {
  registry?: GraphRegistry;
}

export interface GraphRegistry {
  validate(aType: string, abType: string, bType: string, data: unknown): void;
  lookup(aType: string, abType: string, bType: string): RegistryEntry | undefined;
}

export interface GraphReader {
  getNode(uid: string): Promise<StoredGraphRecord | null>;
  getEdge(aUid: string, abType: string, bUid: string): Promise<StoredGraphRecord | null>;
  edgeExists(aUid: string, abType: string, bUid: string): Promise<boolean>;
  findEdges(params: FindEdgesParams): Promise<StoredGraphRecord[]>;
  findNodes(params: FindNodesParams): Promise<StoredGraphRecord[]>;
}

export interface GraphWriter {
  putNode(aType: string, uid: string, data: Record<string, unknown>): Promise<void>;
  putEdge(
    aType: string,
    aUid: string,
    abType: string,
    bType: string,
    bUid: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  updateNode(uid: string, data: Record<string, unknown>): Promise<void>;
  removeNode(uid: string): Promise<void>;
  removeEdge(aUid: string, abType: string, bUid: string): Promise<void>;
}

export interface GraphClient extends GraphReader, GraphWriter {
  runTransaction<T>(fn: (tx: GraphTransaction) => Promise<T>): Promise<T>;
  batch(): GraphBatch;
}

export interface GraphTransaction extends GraphReader, GraphWriter {}

export interface GraphBatch extends GraphWriter {
  commit(): Promise<void>;
}

export interface HopDefinition {
  abType: string;
  direction?: 'forward' | 'reverse';
  aType?: string;
  bType?: string;
  limit?: number;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  filter?: (edge: StoredGraphRecord) => boolean;
}

export interface TraversalOptions {
  maxReads?: number;
  concurrency?: number;
  returnIntermediates?: boolean;
}

export interface HopResult {
  abType: string;
  depth: number;
  edges: StoredGraphRecord[];
  sourceCount: number;
  truncated: boolean;
}

export interface TraversalResult {
  nodes: StoredGraphRecord[];
  hops: HopResult[];
  totalReads: number;
  truncated: boolean;
}

export interface TraversalBuilder {
  follow(abType: string, options?: Omit<HopDefinition, 'abType'>): TraversalBuilder;
  run(options?: TraversalOptions): Promise<TraversalResult>;
}
