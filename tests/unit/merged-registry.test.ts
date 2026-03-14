import { describe, it, expect } from 'vitest';
import { createRegistry, createMergedRegistry } from '../../src/registry.js';
import { RegistryViolationError, ValidationError } from '../../src/errors.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};

const milestoneSchema = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } },
  additionalProperties: false,
};

describe('createMergedRegistry', () => {
  // ---------------------------------------------------------------------------
  // lookup
  // ---------------------------------------------------------------------------

  it('lookup falls through to extension when base has no match', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone', jsonSchema: milestoneSchema },
    ]);
    const merged = createMergedRegistry(base, ext);

    expect(merged.lookup('tour', 'is', 'tour')).toBeDefined();
    expect(merged.lookup('milestone', 'is', 'milestone')).toBeDefined();
  });

  it('lookup returns base entry when both registries define the same triple', () => {
    const baseSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    const extSchema = {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' } },
      additionalProperties: false,
    };
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: baseSchema, description: 'base' },
    ]);
    const ext = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: extSchema, description: 'ext' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const entry = merged.lookup('tour', 'is', 'tour');
    expect(entry?.description).toBe('base');
  });

  it('lookup returns undefined when neither registry has the triple', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone' },
    ]);
    const merged = createMergedRegistry(base, ext);

    expect(merged.lookup('booking', 'is', 'booking')).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // validate
  // ---------------------------------------------------------------------------

  it('validate uses base schema when triple exists in base', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone', jsonSchema: milestoneSchema },
    ]);
    const merged = createMergedRegistry(base, ext);

    // Valid against base schema
    expect(() => merged.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    // Invalid against base schema
    expect(() => merged.validate('tour', 'is', 'tour', { title: 'X' })).toThrow(ValidationError);
  });

  it('validate uses extension schema for extension-only triples', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone', jsonSchema: milestoneSchema },
    ]);
    const merged = createMergedRegistry(base, ext);

    // Valid against extension schema
    expect(() => merged.validate('milestone', 'is', 'milestone', { title: 'Y' })).not.toThrow();
    // Invalid against extension schema
    expect(() => merged.validate('milestone', 'is', 'milestone', { name: 'Y' })).toThrow(ValidationError);
  });

  it('validate throws RegistryViolationError for unregistered triples', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone' },
    ]);
    const merged = createMergedRegistry(base, ext);

    expect(() => merged.validate('booking', 'is', 'booking', {})).toThrow(RegistryViolationError);
  });

  it('validate uses base schema even when extension also defines the triple', () => {
    // Base requires 'name', extension requires 'title' for the same triple
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const ext = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: milestoneSchema },
    ]);
    const merged = createMergedRegistry(base, ext);

    // Should validate against base (requires 'name'), not extension (requires 'title')
    expect(() => merged.validate('tour', 'is', 'tour', { name: 'OK' })).not.toThrow();
    expect(() => merged.validate('tour', 'is', 'tour', { title: 'Nope' })).toThrow(ValidationError);
  });

  // ---------------------------------------------------------------------------
  // entries
  // ---------------------------------------------------------------------------

  it('entries returns deduplicated merged list (base wins)', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', description: 'base-tour' },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const ext = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', description: 'ext-tour' },
      { aType: 'milestone', axbType: 'is', bType: 'milestone' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const entries = merged.entries();
    // 2 from base + 1 unique from ext (tour:is:tour is deduplicated)
    expect(entries).toHaveLength(3);
    const tourEntry = entries.find((e) => e.aType === 'tour' && e.axbType === 'is');
    expect(tourEntry?.description).toBe('base-tour');
  });

  it('entries returns frozen array', () => {
    const base = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
    const ext = createRegistry([{ aType: 'milestone', axbType: 'is', bType: 'milestone' }]);
    const merged = createMergedRegistry(base, ext);

    expect(Object.isFrozen(merged.entries())).toBe(true);
  });

  it('entries returns base entries when extension is empty', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const ext = createRegistry([]);
    const merged = createMergedRegistry(base, ext);

    expect(merged.entries()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // lookupByAxbType
  // ---------------------------------------------------------------------------

  it('lookupByAxbType merges results from both registries', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const ext = createRegistry([
      { aType: 'trek', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const results = merged.lookupByAxbType('hasDeparture');
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.aType).sort()).toEqual(['tour', 'trek']);
  });

  it('lookupByAxbType deduplicates with base winning', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', description: 'base' },
    ]);
    const ext = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', description: 'ext' },
      { aType: 'trek', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const results = merged.lookupByAxbType('hasDeparture');
    expect(results).toHaveLength(2);
    const tourEntry = results.find((e) => e.aType === 'tour');
    expect(tourEntry?.description).toBe('base');
  });

  it('lookupByAxbType returns base-only results when extension has none', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'is', bType: 'milestone' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const results = merged.lookupByAxbType('hasDeparture');
    expect(results).toHaveLength(1);
    expect(results[0].aType).toBe('tour');
  });

  it('lookupByAxbType returns extension-only results when base has none', () => {
    const base = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const ext = createRegistry([
      { aType: 'milestone', axbType: 'hasMilestone', bType: 'task' },
    ]);
    const merged = createMergedRegistry(base, ext);

    const results = merged.lookupByAxbType('hasMilestone');
    expect(results).toHaveLength(1);
    expect(results[0].aType).toBe('milestone');
  });

  it('lookupByAxbType returns empty for unknown axbType', () => {
    const base = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
    const ext = createRegistry([{ aType: 'milestone', axbType: 'is', bType: 'milestone' }]);
    const merged = createMergedRegistry(base, ext);

    expect(merged.lookupByAxbType('nonexistent')).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Scope validation passthrough
  // ---------------------------------------------------------------------------

  it('scope validation works for base entries', () => {
    const base = createRegistry([
      { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['agents'] },
    ]);
    const ext = createRegistry([]);
    const merged = createMergedRegistry(base, ext);

    expect(() => merged.validate('memory', 'is', 'memory', {}, 'agents')).not.toThrow();
    expect(() => merged.validate('memory', 'is', 'memory', {}, 'tasks')).toThrow();
  });

  it('scope validation works for extension entries', () => {
    const base = createRegistry([]);
    const ext = createRegistry([
      { aType: 'note', axbType: 'is', bType: 'note', allowedIn: ['**/notes'] },
    ]);
    const merged = createMergedRegistry(base, ext);

    expect(() => merged.validate('note', 'is', 'note', {}, 'foo/notes')).not.toThrow();
    expect(() => merged.validate('note', 'is', 'note', {}, 'tasks')).toThrow();
  });
});
