import type { SummarizedEdge, SummarizedRecord } from './types.js';

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
    fromType: r.aType as string,
    fromUid: r.aUid as string,
    relation: r.axbType as string,
    toType: r.bType as string,
    toUid: r.bUid as string,
  };
  const data = r.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object' && Object.keys(data).length > 0) {
    out.data = data;
  }
  return out;
}
