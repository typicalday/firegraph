import { describe, expect, it } from 'vitest';

import { generateId } from '../../src/id.js';

describe('generateId', () => {
  it('returns a 21-character string', () => {
    const id = generateId();
    expect(id).toHaveLength(21);
  });

  it('produces URL-safe characters only', () => {
    const id = generateId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique IDs (10,000 with zero collisions)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(10_000);
  });
});
