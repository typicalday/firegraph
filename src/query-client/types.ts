// --- Shared ---

export interface WhereClause {
  field: string;
  op: string;
  value: string | number | boolean;
}

// --- Summarized output shapes ---

export interface SummarizedRecord {
  type: string;
  uid: string;
  data?: Record<string, unknown>;
}

export interface SummarizedEdge {
  from: string;
  relation: string;
  to: string;
  data?: Record<string, unknown>;
}

// --- getSchema ---

export interface SchemaResult {
  nodeTypes: string[];
  edgeTypes: {
    relation: string;
    from: string;
    to: string;
    inverseLabel: string | null;
  }[];
}

// --- getNodeDetail ---

export interface GetNodeDetailInput {
  uid: string;
}

export interface NodeDetailResult {
  node: SummarizedRecord | null;
  outEdges: SummarizedEdge[];
  inEdges: SummarizedEdge[];
}

// --- getNodes ---

export interface GetNodesInput {
  type?: string;
  limit?: number;
  startAfter?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  where?: WhereClause[];
}

export interface GetNodesResult {
  nodes: SummarizedRecord[];
  hasMore: boolean;
  nextCursor?: string | null;
}

// --- getEdges ---

export interface GetEdgesInput {
  aType?: string;
  aUid?: string;
  axbType?: string;
  bType?: string;
  bUid?: string;
  limit?: number;
  startAfter?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  where?: WhereClause[];
}

export interface GetEdgesResult {
  edges: SummarizedEdge[];
  hasMore: boolean;
  nextCursor?: string | null;
}

// --- traverse ---

export interface TraverseHop {
  axbType: string;
  direction?: 'forward' | 'reverse';
  limit?: number;
  aType?: string;
  bType?: string;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  where?: WhereClause[];
}

export interface TraverseInput {
  startUid: string;
  hops: TraverseHop[];
  maxReads?: number;
  concurrency?: number;
}

export interface TraverseHopResult {
  relation: string;
  direction: string;
  depth: number;
  edgeCount: number;
  edges: SummarizedEdge[];
  truncated: boolean;
}

export interface TraverseResult {
  hops: TraverseHopResult[];
  totalReads: number;
  truncated: boolean;
}

// --- search ---

export interface SearchInput {
  q: string;
  limit?: number;
}

export interface SearchResult {
  results: (SummarizedRecord & { matchType: string | null })[];
}

// --- Client options ---

export interface QueryClientOptions {
  /** Editor server port. Default: auto-detected from config, fallback 3884. */
  port?: number;
  /** Editor server hostname. Default: 'localhost'. */
  host?: string;
}
