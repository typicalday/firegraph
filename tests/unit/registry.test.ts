import { describe, it, expect } from 'vitest';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError, ValidationError } from '../../src/errors.js';

const tourSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
  additionalProperties: false,
};

const edgeSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'number' } },
  additionalProperties: false,
};

describe('createRegistry', () => {
  it('lookup returns the entry for a registered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    const entry = registry.lookup('tour', 'is', 'tour');
    expect(entry).toBeDefined();
    expect(entry!.aType).toBe('tour');
  });

  it('lookup returns undefined for an unregistered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const entry = registry.lookup('user', 'is', 'user');
    expect(entry).toBeUndefined();
  });

  it('validate passes for a registered triple with valid data', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'Dolomites' })).not.toThrow();
  });

  it('validate throws RegistryViolationError for unregistered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    expect(() => registry.validate('booking', 'is', 'booking', {})).toThrow(
      RegistryViolationError,
    );
  });

  it('validate throws ValidationError for invalid data', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 123 })).toThrow(
      ValidationError,
    );
  });

  it('validate passes when no jsonSchema is defined', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { anything: 'goes' })).not.toThrow();
  });

  it('supports multiple triples', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    expect(() => registry.validate('tour', 'hasDeparture', 'departure', { order: 0 })).not.toThrow();
  });

  it('entries returns all registered entries', () => {
    const entries = [
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ];
    const registry = createRegistry(entries);
    const result = registry.entries();
    expect(result).toHaveLength(2);
    expect(result[0].aType).toBe('tour');
    expect(result[0].axbType).toBe('is');
    expect(result[1].axbType).toBe('hasDeparture');
  });

  it('entries returns a frozen array (defensive copy)', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const result = registry.entries();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('ValidationError includes details', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    try {
      registry.validate('tour', 'is', 'tour', { name: 123 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toBeDefined();
    }
  });

  it('preserves inverseLabel on lookup', () => {
    const registry = createRegistry([
      { aType: 'task', axbType: 'hasStep', bType: 'step', inverseLabel: 'stepOf' },
    ]);
    const entry = registry.lookup('task', 'hasStep', 'step');
    expect(entry?.inverseLabel).toBe('stepOf');
  });

  it('returns inverseLabel via entries()', () => {
    const registry = createRegistry([
      { aType: 'task', axbType: 'hasStep', bType: 'step', inverseLabel: 'stepOf' },
    ]);
    const [entry] = registry.entries();
    expect(entry.inverseLabel).toBe('stepOf');
  });

  it('creates registry from DiscoveryResult', () => {
    const discovery = {
      nodes: new Map([
        ['tour', { kind: 'node' as const, name: 'tour', schema: tourSchema }],
        ['departure', { kind: 'node' as const, name: 'departure', schema: { type: 'object', properties: {} } }],
      ]),
      edges: new Map([
        ['hasDeparture', {
          kind: 'edge' as const,
          name: 'hasDeparture',
          schema: edgeSchema,
          topology: { from: 'tour', to: 'departure', inverseLabel: 'departureOf' },
        }],
      ]),
    };
    const registry = createRegistry(discovery);

    // Node self-loop triples
    expect(registry.lookup('tour', 'is', 'tour')).toBeDefined();
    expect(registry.lookup('departure', 'is', 'departure')).toBeDefined();

    // Edge triple
    expect(registry.lookup('tour', 'hasDeparture', 'departure')).toBeDefined();
    const edge = registry.lookup('tour', 'hasDeparture', 'departure');
    expect(edge?.inverseLabel).toBe('departureOf');

    // Validation works
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    expect(() => registry.validate('tour', 'hasDeparture', 'departure', { order: 1 })).not.toThrow();
    expect(() => registry.validate('tour', 'hasDeparture', 'departure', { order: 'bad' })).toThrow(ValidationError);
  });

  it('expands array from/to in edge topology', () => {
    const discovery = {
      nodes: new Map([
        ['a', { kind: 'node' as const, name: 'a', schema: { type: 'object' } }],
        ['b', { kind: 'node' as const, name: 'b', schema: { type: 'object' } }],
        ['c', { kind: 'node' as const, name: 'c', schema: { type: 'object' } }],
      ]),
      edges: new Map([
        ['connects', {
          kind: 'edge' as const,
          name: 'connects',
          schema: { type: 'object', properties: {} },
          topology: { from: ['a', 'b'], to: 'c' },
        }],
      ]),
    };
    const registry = createRegistry(discovery);

    expect(registry.lookup('a', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('b', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('a', 'connects', 'b')).toBeUndefined();
  });
});
