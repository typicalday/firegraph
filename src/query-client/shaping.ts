import type { SummarizedRecord, SummarizedEdge } from './types.js';

export function summarizeRecord(r: Record<string, unknown> | null): SummarizedRecord | null {
  if (!r) return null;
  const out: SummarizedRecord = { type: r.aType as string, uid: r.aUid as string };
  const data = r.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && Object.keys(data).length > 0) {
    out.data = data;
  }
  return out;
}

export function summarizeEdge(r: Record<string, unknown> | null): SummarizedEdge | null {
  if (!r) return null;
  const out: SummarizedEdge = {
    from: `${r.aType}:${r.aUid}`,
    relation: r.axbType as string,
    to: `${r.bType}:${r.bUid}`,
  };
  const data = r.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && Object.keys(data).length > 0) {
    out.data = data;
  }
  return out;
}
