import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { computeNodeDocId, computeEdgeDocId } from '../../src/docid.js';

describe('computeNodeDocId', () => {
  it('returns the uid unchanged', () => {
    expect(computeNodeDocId('abc123')).toBe('abc123');
  });

  it('handles special characters', () => {
    expect(computeNodeDocId('node-with_special.chars')).toBe('node-with_special.chars');
  });
});

describe('computeEdgeDocId', () => {
  it('returns shard:aUid:axbType:bUid format', () => {
    const docId = computeEdgeDocId('a1', 'hasDeparture', 'b2');
    const parts = docId.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[1]).toBe('a1');
    expect(parts[2]).toBe('hasDeparture');
    expect(parts[3]).toBe('b2');
  });

  it('shard is a single hex character (0-f)', () => {
    const docId = computeEdgeDocId('a1', 'rel', 'b2');
    const shard = docId[0];
    expect(shard).toMatch(/^[0-9a-f]$/);
  });

  it('shard is the first char of SHA-256 of composite key', () => {
    const composite = 'a1:rel:b2';
    const expectedShard = createHash('sha256').update(composite).digest('hex')[0];
    const docId = computeEdgeDocId('a1', 'rel', 'b2');
    expect(docId[0]).toBe(expectedShard);
  });

  it('is deterministic (same inputs produce same output)', () => {
    const id1 = computeEdgeDocId('x', 'likes', 'y');
    const id2 = computeEdgeDocId('x', 'likes', 'y');
    expect(id1).toBe(id2);
  });

  it('different inputs produce different outputs', () => {
    const id1 = computeEdgeDocId('a', 'rel', 'b');
    const id2 = computeEdgeDocId('a', 'rel', 'c');
    expect(id1).not.toBe(id2);
  });

  it('distributes across shards (statistical test)', () => {
    const shards = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const docId = computeEdgeDocId(`a${i}`, 'rel', `b${i}`);
      shards.add(docId[0]);
    }
    expect(shards.size).toBeGreaterThanOrEqual(10);
  });
});
