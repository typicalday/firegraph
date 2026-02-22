import type { Schema, GraphRecord, NodeDetailData, TraversalResult, HopDef, AppConfig, ViewRegistryData } from './types';

const BASE = '/api';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getConfig(): Promise<AppConfig> {
  return fetchJson(`${BASE}/config`);
}

export async function getSchema(): Promise<Schema> {
  return fetchJson(`${BASE}/schema`);
}

export async function getViews(): Promise<ViewRegistryData> {
  return fetchJson(`${BASE}/views`);
}

export interface GetNodesParams {
  limit?: number;
  startAfter?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  filterField?: string;
  filterOp?: string;
  filterValue?: string;
}

export async function getNodes(
  type?: string,
  params: GetNodesParams = {},
): Promise<{ nodes: GraphRecord[]; hasMore: boolean; nextCursor: string | null }> {
  const searchParams = new URLSearchParams();
  if (type) searchParams.set('type', type);
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.startAfter) searchParams.set('startAfter', params.startAfter);
  if (params.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params.sortDir) searchParams.set('sortDir', params.sortDir);
  if (params.filterField) searchParams.set('filterField', params.filterField);
  if (params.filterOp) searchParams.set('filterOp', params.filterOp);
  if (params.filterValue !== undefined) searchParams.set('filterValue', params.filterValue);
  return fetchJson(`${BASE}/nodes?${searchParams}`);
}

export async function getNodeDetail(uid: string): Promise<NodeDetailData> {
  return fetchJson(`${BASE}/node/${encodeURIComponent(uid)}`);
}

export async function getNodesBatch(
  uids: string[],
): Promise<{ nodes: Record<string, GraphRecord | null> }> {
  return fetchJson(`${BASE}/nodes/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uids }),
  });
}

export async function getEdges(params: {
  aType?: string;
  aUid?: string;
  abType?: string;
  bType?: string;
  bUid?: string;
  limit?: number;
  startAfter?: string;
}): Promise<{ edges: GraphRecord[]; hasMore: boolean; nextCursor: string | null }> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return fetchJson(`${BASE}/edges?${searchParams}`);
}

export async function runTraversal(
  startUid: string,
  hops: HopDef[],
  maxReads = 100,
  concurrency = 5,
): Promise<TraversalResult> {
  return fetchJson(`${BASE}/traverse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startUid, hops, maxReads, concurrency }),
  });
}

export async function search(
  q: string,
  limit = 20,
): Promise<{ results: GraphRecord[] }> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return fetchJson(`${BASE}/search?${params}`);
}

// --- Write Operations ---

export async function createNode(
  aType: string,
  uid: string | undefined,
  data: Record<string, unknown>,
): Promise<{ success: boolean; uid: string }> {
  return fetchJson(`${BASE}/node`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aType, uid: uid || undefined, data }),
  });
}

export async function updateNode(
  uid: string,
  data: Record<string, unknown>,
): Promise<{ success: boolean }> {
  return fetchJson(`${BASE}/node/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

export async function deleteNode(uid: string): Promise<{ success: boolean }> {
  return fetchJson(`${BASE}/node/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
  });
}

export async function createEdge(
  aType: string,
  aUid: string,
  abType: string,
  bType: string,
  bUid: string,
  data: Record<string, unknown>,
): Promise<{ success: boolean }> {
  return fetchJson(`${BASE}/edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aType, aUid, abType, bType, bUid, data }),
  });
}

export async function deleteEdge(
  aUid: string,
  abType: string,
  bUid: string,
): Promise<{ success: boolean }> {
  return fetchJson(`${BASE}/edge`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aUid, abType, bUid }),
  });
}
