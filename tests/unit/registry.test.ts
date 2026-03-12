import { describe, it, expect } from 'vitest';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError, RegistryScopeError, ValidationError } from '../../src/errors.js';

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

  // ---------------------------------------------------------------------------
  // Scope validation (allowedIn)
  // ---------------------------------------------------------------------------

  it('validate passes when no allowedIn is defined (backwards compatible)', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    // Passing a scopePath should still pass when there's no allowedIn restriction
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' }, 'agents')).not.toThrow();
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' }, '')).not.toThrow();
  });

  it('validate passes when scopePath is undefined (skips scope check)', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema, allowedIn: ['root'] },
    ]);
    // undefined scopePath means we're not in a scope-aware context — skip check
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
  });

  it('validate passes when allowedIn matches the scopePath', () => {
    const registry = createRegistry([
      { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['agents', '**/memories'] },
    ]);
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'agents')).not.toThrow();
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'foo/memories')).not.toThrow();
  });

  it('validate throws RegistryScopeError when scopePath is not allowed', () => {
    const registry = createRegistry([
      { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['agents'] },
    ]);
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'tasks')).toThrow(
      RegistryScopeError,
    );
    expect(() => registry.validate('memory', 'is', 'memory', {}, '')).toThrow(
      RegistryScopeError,
    );
  });

  it('validate passes when allowedIn is empty (allowed everywhere)', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', allowedIn: [] },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', {}, 'anywhere')).not.toThrow();
  });

  it('RegistryScopeError includes scope and allowedIn info', () => {
    const registry = createRegistry([
      { aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['agents'] },
    ]);
    try {
      registry.validate('memory', 'is', 'memory', {}, 'tasks');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryScopeError);
      expect((err as RegistryScopeError).message).toContain('tasks');
      expect((err as RegistryScopeError).message).toContain('agents');
      expect((err as RegistryScopeError).code).toBe('REGISTRY_SCOPE');
    }
  });

  it('discoveryToEntries propagates allowedIn', () => {
    const discovery = {
      nodes: new Map([
        ['memory', { kind: 'node' as const, name: 'memory', schema: { type: 'object' }, allowedIn: ['**/memories'] }],
      ]),
      edges: new Map([
        ['recalls', {
          kind: 'edge' as const,
          name: 'recalls',
          schema: { type: 'object', properties: {} },
          topology: { from: 'memory', to: 'memory' },
          allowedIn: ['**/memories'],
        }],
      ]),
    };
    const registry = createRegistry(discovery);

    // Both should have scope constraints from discovery
    const nodeEntry = registry.lookup('memory', 'is', 'memory');
    expect(nodeEntry?.allowedIn).toEqual(['**/memories']);

    const edgeEntry = registry.lookup('memory', 'recalls', 'memory');
    expect(edgeEntry?.allowedIn).toEqual(['**/memories']);

    // Should pass at correct scope
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'agents/memories')).not.toThrow();

    // Should fail at wrong scope
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'agents')).toThrow(RegistryScopeError);
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
