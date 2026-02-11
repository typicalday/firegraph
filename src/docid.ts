import { createHash } from 'node:crypto';
import { SHARD_SEPARATOR } from './internal/constants.js';

export function computeNodeDocId(uid: string): string {
  return uid;
}

export function computeEdgeDocId(aUid: string, abType: string, bUid: string): string {
  const composite = `${aUid}${SHARD_SEPARATOR}${abType}${SHARD_SEPARATOR}${bUid}`;
  const hash = createHash('sha256').update(composite).digest('hex');
  const shard = hash[0];
  return `${shard}${SHARD_SEPARATOR}${aUid}${SHARD_SEPARATOR}${abType}${SHARD_SEPARATOR}${bUid}`;
}
