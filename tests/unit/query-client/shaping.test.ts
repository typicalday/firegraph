import { describe, expect, it } from 'vitest';

import { summarizeEdge, summarizeRecord } from '../../../src/query-client/shaping.js';

describe('summarizeRecord', () => {
  it('returns null for null input', () => {
    expect(summarizeRecord(null)).toBeNull();
  });

  it('extracts type and uid', () => {
    const result = summarizeRecord({ aType: 'task', aUid: 'task1' });
    expect(result).toEqual({ type: 'task', uid: 'task1' });
  });

  it('includes data when present and non-empty', () => {
    const result = summarizeRecord({
      aType: 'task',
      aUid: 'task1',
      data: { title: 'Fix bug', status: 'active' },
    });
    expect(result).toEqual({
      type: 'task',
      uid: 'task1',
      data: { title: 'Fix bug', status: 'active' },
    });
  });

  it('omits data when empty object', () => {
    const result = summarizeRecord({ aType: 'task', aUid: 'task1', data: {} });
    expect(result).toEqual({ type: 'task', uid: 'task1' });
    expect(result!.data).toBeUndefined();
  });

  it('omits data when undefined', () => {
    const result = summarizeRecord({ aType: 'task', aUid: 'task1' });
    expect(result!.data).toBeUndefined();
  });

  it('omits data when not an object', () => {
    const result = summarizeRecord({ aType: 'task', aUid: 'task1', data: 'notanobject' });
    expect(result!.data).toBeUndefined();
  });
});

describe('summarizeEdge', () => {
  it('returns null for null input', () => {
    expect(summarizeEdge(null)).toBeNull();
  });

  it('extracts fromType, fromUid, relation, toType, and toUid', () => {
    const result = summarizeEdge({
      aType: 'task',
      aUid: 'task1',
      axbType: 'hasStep',
      bType: 'step',
      bUid: 'step1',
    });
    expect(result).toEqual({
      fromType: 'task',
      fromUid: 'task1',
      relation: 'hasStep',
      toType: 'step',
      toUid: 'step1',
    });
  });

  it('includes data when present and non-empty', () => {
    const result = summarizeEdge({
      aType: 'task',
      aUid: 'task1',
      axbType: 'hasStep',
      bType: 'step',
      bUid: 'step1',
      data: { order: 1 },
    });
    expect(result).toEqual({
      fromType: 'task',
      fromUid: 'task1',
      relation: 'hasStep',
      toType: 'step',
      toUid: 'step1',
      data: { order: 1 },
    });
  });

  it('omits data when empty object', () => {
    const result = summarizeEdge({
      aType: 'task',
      aUid: 'task1',
      axbType: 'hasStep',
      bType: 'step',
      bUid: 'step1',
      data: {},
    });
    expect(result!.data).toBeUndefined();
  });
});
