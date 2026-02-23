import { FieldValue } from 'firebase-admin/firestore';
import { NODE_RELATION } from './internal/constants.js';
import type { GraphRecord } from './types.js';

export function buildNodeRecord(
  aType: string,
  uid: string,
  data: Record<string, unknown>,
): GraphRecord {
  const now = FieldValue.serverTimestamp();
  return {
    aType,
    aUid: uid,
    axbType: NODE_RELATION,
    bType: aType,
    bUid: uid,
    data,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildEdgeRecord(
  aType: string,
  aUid: string,
  axbType: string,
  bType: string,
  bUid: string,
  data: Record<string, unknown>,
): GraphRecord {
  const now = FieldValue.serverTimestamp();
  return {
    aType,
    aUid,
    axbType,
    bType,
    bUid,
    data,
    createdAt: now,
    updatedAt: now,
  };
}
