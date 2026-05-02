import { describe, expect, it } from 'vitest';

import {
  compileEngineTraversal,
  MAX_PIPELINE_DEPTH,
} from '../../src/internal/firestore-traverse-compiler.js';
import type { EngineTraversalParams } from '../../src/types.js';

describe('compileEngineTraversal', () => {
  it('rejects empty hops', () => {
    const result = compileEngineTraversal({ sources: ['a'], hops: [] });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/at least one hop/);
    }
  });

  it('accepts a single-hop spec with limitPerSource set', () => {
    const params: EngineTraversalParams = {
      sources: ['a', 'b', 'c'],
      hops: [{ axbType: 'rel', limitPerSource: 5 }],
    };
    const result = compileEngineTraversal(params);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.hops).toHaveLength(1);
      expect(result.normalized.hops[0].direction).toBe('forward'); // default
      expect(result.normalized.estimatedReads).toBe(15); // 3 * 5
    }
  });

  it('defaults direction to forward', () => {
    const params: EngineTraversalParams = {
      sources: ['a'],
      hops: [{ axbType: 'rel', limitPerSource: 1 }],
    };
    const result = compileEngineTraversal(params);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.hops[0].direction).toBe('forward');
    }
  });

  it('honors explicit reverse direction', () => {
    const params: EngineTraversalParams = {
      sources: ['a'],
      hops: [{ axbType: 'rel', direction: 'reverse', limitPerSource: 1 }],
    };
    const result = compileEngineTraversal(params);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.hops[0].direction).toBe('reverse');
    }
  });

  it('rejects a hop missing limitPerSource', () => {
    const result = compileEngineTraversal({
      sources: ['a'],
      // Force-cast to exercise the runtime check.
      hops: [{ axbType: 'rel' } as never],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/limitPerSource/);
    }
  });

  it('rejects zero or negative limitPerSource', () => {
    const zero = compileEngineTraversal({
      sources: ['a'],
      hops: [{ axbType: 'rel', limitPerSource: 0 }],
    });
    expect(zero.eligible).toBe(false);

    const neg = compileEngineTraversal({
      sources: ['a'],
      hops: [{ axbType: 'rel', limitPerSource: -1 }],
    });
    expect(neg.eligible).toBe(false);
  });

  it('rejects a hop missing axbType', () => {
    const result = compileEngineTraversal({
      sources: ['a'],
      hops: [{ axbType: '', limitPerSource: 1 }],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/axbType/);
    }
  });

  it('rejects depth above MAX_PIPELINE_DEPTH', () => {
    const hops = Array.from({ length: MAX_PIPELINE_DEPTH + 1 }, (_, i) => ({
      axbType: `rel${i}`,
      limitPerSource: 2,
    }));
    const result = compileEngineTraversal({ sources: ['a'], hops });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/MAX_PIPELINE_DEPTH/);
    }
  });

  it('honors a custom maxDepth override', () => {
    const hops = Array.from({ length: 3 }, (_, i) => ({
      axbType: `rel${i}`,
      limitPerSource: 1,
    }));
    const result = compileEngineTraversal({ sources: ['a'], hops }, { maxDepth: 2 });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/exceeds MAX_PIPELINE_DEPTH \(2\)/);
    }
  });

  it('estimates response size as sources.length × Π(limitPerSource_i)', () => {
    const result = compileEngineTraversal({
      sources: ['a', 'b'],
      hops: [
        { axbType: 'r1', limitPerSource: 3 },
        { axbType: 'r2', limitPerSource: 4 },
      ],
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.estimatedReads).toBe(2 * 3 * 4); // 24
    }
  });

  it('refuses when estimated reads exceed maxReads budget', () => {
    const result = compileEngineTraversal({
      sources: ['a'],
      hops: [
        { axbType: 'r1', limitPerSource: 100 },
        { axbType: 'r2', limitPerSource: 100 },
      ],
      maxReads: 5000,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/exceeds maxReads/);
    }
  });

  it('respects opts.maxReads override over params.maxReads', () => {
    const params: EngineTraversalParams = {
      sources: ['a'],
      hops: [
        { axbType: 'r1', limitPerSource: 10 },
        { axbType: 'r2', limitPerSource: 10 },
      ],
      maxReads: 1000, // would pass at 100
    };
    // opts.maxReads is stricter.
    const result = compileEngineTraversal(params, { maxReads: 50 });
    expect(result.eligible).toBe(false);
  });

  it('handles empty sources without estimating zero reads', () => {
    // Empty sources is allowed at the compiler level (the executor
    // short-circuits with empty results); estimate uses max(1, len).
    const result = compileEngineTraversal({
      sources: [],
      hops: [{ axbType: 'r1', limitPerSource: 5 }],
    });
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.estimatedReads).toBe(5); // 1 * 5
    }
  });

  it('clamps estimatedReads at MAX_SAFE_INTEGER on overflow', () => {
    const hops = Array.from({ length: MAX_PIPELINE_DEPTH }, () => ({
      axbType: 'rel',
      limitPerSource: 100_000_000,
    }));
    const result = compileEngineTraversal(
      { sources: Array.from({ length: 1_000_000 }, (_, i) => `s${i}`), hops },
      { maxReads: Number.MAX_SAFE_INTEGER },
    );
    // The estimate is clamped to MAX_SAFE_INTEGER; with maxReads === MAX_SAFE_INTEGER
    // the comparison is `>` so it remains eligible (not strictly exceeding).
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.normalized.estimatedReads).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('rejects a non-array sources field', () => {
    const result = compileEngineTraversal({
      sources: 'not an array' as never,
      hops: [{ axbType: 'rel', limitPerSource: 1 }],
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toMatch(/sources array/);
    }
  });

  it('preserves orderBy / aType / bType on normalized hops', () => {
    const params: EngineTraversalParams = {
      sources: ['a'],
      hops: [
        {
          axbType: 'rel',
          aType: 'tour',
          bType: 'departure',
          limitPerSource: 3,
          orderBy: { field: 'data.date', direction: 'desc' },
        },
      ],
    };
    const result = compileEngineTraversal(params);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      const hop = result.normalized.hops[0];
      expect(hop.aType).toBe('tour');
      expect(hop.bType).toBe('departure');
      expect(hop.orderBy).toEqual({ field: 'data.date', direction: 'desc' });
    }
  });
});
