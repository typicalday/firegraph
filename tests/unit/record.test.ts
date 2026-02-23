import { describe, it, expect } from 'vitest';
import { buildNodeRecord, buildEdgeRecord } from '../../src/record.js';
import { NODE_RELATION } from '../../src/internal/constants.js';

describe('buildNodeRecord', () => {
  it('sets aType === bType', () => {
    const record = buildNodeRecord('tour', 'abc', { name: 'X' });
    expect(record.aType).toBe('tour');
    expect(record.bType).toBe('tour');
  });

  it('sets aUid === bUid', () => {
    const record = buildNodeRecord('tour', 'abc', { name: 'X' });
    expect(record.aUid).toBe('abc');
    expect(record.bUid).toBe('abc');
  });

  it('sets axbType to NODE_RELATION ("is")', () => {
    const record = buildNodeRecord('tour', 'abc', {});
    expect(record.axbType).toBe(NODE_RELATION);
    expect(record.axbType).toBe('is');
  });

  it('stores data in the data field', () => {
    const data = { name: 'Dolomites', difficulty: 'hard' };
    const record = buildNodeRecord('tour', 'abc', data);
    expect(record.data).toEqual(data);
  });

  it('includes createdAt and updatedAt as FieldValues', () => {
    const record = buildNodeRecord('tour', 'abc', {});
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
  });
});

describe('buildEdgeRecord', () => {
  it('stores aType and bType separately', () => {
    const record = buildEdgeRecord('tour', 'a1', 'hasDeparture', 'departure', 'b2', {});
    expect(record.aType).toBe('tour');
    expect(record.bType).toBe('departure');
  });

  it('stores aUid and bUid separately', () => {
    const record = buildEdgeRecord('tour', 'a1', 'hasDeparture', 'departure', 'b2', {});
    expect(record.aUid).toBe('a1');
    expect(record.bUid).toBe('b2');
  });

  it('stores the relationship type in axbType', () => {
    const record = buildEdgeRecord('tour', 'a1', 'hasDeparture', 'departure', 'b2', {});
    expect(record.axbType).toBe('hasDeparture');
  });

  it('stores data in the data field', () => {
    const data = { order: 0, isPrimary: true };
    const record = buildEdgeRecord('tour', 'a1', 'hasDeparture', 'departure', 'b2', data);
    expect(record.data).toEqual(data);
  });

  it('includes createdAt and updatedAt as FieldValues', () => {
    const record = buildEdgeRecord('tour', 'a1', 'hasDeparture', 'departure', 'b2', {});
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
  });
});
