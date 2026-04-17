import { describe, expect, it } from 'vitest';

import {
  MigrationError,
  RegistryScopeError,
  RegistryViolationError,
  ValidationError,
} from '../../src/errors.js';
import { createRegistry } from '../../src/registry.js';

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
    const registry = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
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
    const registry = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
    expect(() => registry.validate('booking', 'is', 'booking', {})).toThrow(RegistryViolationError);
  });

  it('validate throws ValidationError for invalid data', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 123 })).toThrow(ValidationError);
  });

  it('validate passes when no jsonSchema is defined', () => {
    const registry = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
    expect(() => registry.validate('tour', 'is', 'tour', { anything: 'goes' })).not.toThrow();
  });

  it('supports multiple triples', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'is', bType: 'tour', jsonSchema: tourSchema },
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure', jsonSchema: edgeSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    expect(() =>
      registry.validate('tour', 'hasDeparture', 'departure', { order: 0 }),
    ).not.toThrow();
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
    const registry = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
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
        [
          'departure',
          { kind: 'node' as const, name: 'departure', schema: { type: 'object', properties: {} } },
        ],
      ]),
      edges: new Map([
        [
          'hasDeparture',
          {
            kind: 'edge' as const,
            name: 'hasDeparture',
            schema: edgeSchema,
            topology: { from: 'tour', to: 'departure', inverseLabel: 'departureOf' },
          },
        ],
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
    expect(() =>
      registry.validate('tour', 'hasDeparture', 'departure', { order: 1 }),
    ).not.toThrow();
    expect(() => registry.validate('tour', 'hasDeparture', 'departure', { order: 'bad' })).toThrow(
      ValidationError,
    );
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
    expect(() => registry.validate('memory', 'is', 'memory', {}, '')).toThrow(RegistryScopeError);
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
        [
          'memory',
          {
            kind: 'node' as const,
            name: 'memory',
            schema: { type: 'object' },
            allowedIn: ['**/memories'],
          },
        ],
      ]),
      edges: new Map([
        [
          'recalls',
          {
            kind: 'edge' as const,
            name: 'recalls',
            schema: { type: 'object', properties: {} },
            topology: { from: 'memory', to: 'memory' },
            allowedIn: ['**/memories'],
          },
        ],
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
    expect(() => registry.validate('memory', 'is', 'memory', {}, 'agents')).toThrow(
      RegistryScopeError,
    );
  });

  // ---------------------------------------------------------------------------
  // lookupByAxbType
  // ---------------------------------------------------------------------------

  it('lookupByAxbType returns all entries with matching axbType', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure' },
      { aType: 'trek', axbType: 'hasDeparture', bType: 'departure' },
      { aType: 'tour', axbType: 'is', bType: 'tour' },
    ]);
    const results = registry.lookupByAxbType('hasDeparture');
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.aType).sort()).toEqual(['tour', 'trek']);
  });

  it('lookupByAxbType returns empty array for unknown axbType', () => {
    const registry = createRegistry([{ aType: 'tour', axbType: 'is', bType: 'tour' }]);
    expect(registry.lookupByAxbType('nonexistent')).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // targetGraph propagation
  // ---------------------------------------------------------------------------

  it('preserves targetGraph on lookup', () => {
    const registry = createRegistry([
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
    ]);
    const entry = registry.lookup('task', 'assignedTo', 'agent');
    expect(entry?.targetGraph).toBe('workflow');
  });

  it('lookupByAxbType includes targetGraph', () => {
    const registry = createRegistry([
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
    ]);
    const entries = registry.lookupByAxbType('assignedTo');
    expect(entries[0]?.targetGraph).toBe('workflow');
  });

  it('discoveryToEntries propagates targetGraph from topology', () => {
    const discovery = {
      nodes: new Map([
        ['task', { kind: 'node' as const, name: 'task', schema: { type: 'object' } }],
        ['agent', { kind: 'node' as const, name: 'agent', schema: { type: 'object' } }],
      ]),
      edges: new Map([
        [
          'assignedTo',
          {
            kind: 'edge' as const,
            name: 'assignedTo',
            schema: { type: 'object', properties: {} },
            topology: { from: 'task', to: 'agent', targetGraph: 'workflow' },
          },
        ],
      ]),
    };
    const registry = createRegistry(discovery);
    const entry = registry.lookup('task', 'assignedTo', 'agent');
    expect(entry?.targetGraph).toBe('workflow');
  });

  it('lookupByAxbType returns a frozen array', () => {
    const registry = createRegistry([
      { aType: 'tour', axbType: 'hasDeparture', bType: 'departure' },
    ]);
    const results = registry.lookupByAxbType('hasDeparture');
    expect(Object.isFrozen(results)).toBe(true);
  });

  it('lookupByAxbType returns entries with different targetGraph values', () => {
    const registry = createRegistry([
      { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'workflow' },
      { aType: 'project', axbType: 'assignedTo', bType: 'agent', targetGraph: 'team' },
    ]);
    const results = registry.lookupByAxbType('assignedTo');
    expect(results).toHaveLength(2);
    const graphs = results.map((e) => e.targetGraph).sort();
    expect(graphs).toEqual(['team', 'workflow']);
  });

  it('throws ValidationError when targetGraph contains a slash', () => {
    expect(() =>
      createRegistry([
        { aType: 'task', axbType: 'assignedTo', bType: 'agent', targetGraph: 'work/flow' },
      ]),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError when discoveryToEntries targetGraph contains a slash', () => {
    const discovery = {
      nodes: new Map([
        ['task', { kind: 'node' as const, name: 'task', schema: { type: 'object' } }],
        ['agent', { kind: 'node' as const, name: 'agent', schema: { type: 'object' } }],
      ]),
      edges: new Map([
        [
          'assignedTo',
          {
            kind: 'edge' as const,
            name: 'assignedTo',
            schema: { type: 'object', properties: {} },
            topology: { from: 'task', to: 'agent', targetGraph: 'work/flow' },
          },
        ],
      ]),
    };
    expect(() => createRegistry(discovery)).toThrow(ValidationError);
  });

  it('expands array from/to in edge topology', () => {
    const discovery = {
      nodes: new Map([
        ['a', { kind: 'node' as const, name: 'a', schema: { type: 'object' } }],
        ['b', { kind: 'node' as const, name: 'b', schema: { type: 'object' } }],
        ['c', { kind: 'node' as const, name: 'c', schema: { type: 'object' } }],
      ]),
      edges: new Map([
        [
          'connects',
          {
            kind: 'edge' as const,
            name: 'connects',
            schema: { type: 'object', properties: {} },
            topology: { from: ['a', 'b'], to: 'c' },
          },
        ],
      ]),
    };
    const registry = createRegistry(discovery);

    expect(registry.lookup('a', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('b', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('a', 'connects', 'b')).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Migration validation
  // ---------------------------------------------------------------------------

  it('accepts entry with migrations', () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        migrations: [{ fromVersion: 0, toVersion: 1, up: (d) => ({ ...d, migrated: true }) }],
      },
    ]);
    expect(registry.lookup('tour', 'is', 'tour')?.schemaVersion).toBe(1);
  });

  it('throws MigrationError when migration chain has a gap', () => {
    expect(() =>
      createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          migrations: [
            { fromVersion: 0, toVersion: 1, up: (d) => d },
            // gap: missing v1 -> v2
            { fromVersion: 2, toVersion: 3, up: (d) => d },
          ],
        },
      ]),
    ).toThrow(MigrationError);
  });

  it('accepts complete migration chain at registry construction', () => {
    expect(() =>
      createRegistry([
        {
          aType: 'tour',
          axbType: 'is',
          bType: 'tour',
          migrations: [
            { fromVersion: 0, toVersion: 1, up: (d) => d },
            { fromVersion: 1, toVersion: 2, up: (d) => d },
            { fromVersion: 2, toVersion: 3, up: (d) => d },
          ],
        },
      ]),
    ).not.toThrow();
  });

  it('does not require v in data for schemas with additionalProperties: false', () => {
    const registry = createRegistry([
      {
        aType: 'tour',
        axbType: 'is',
        bType: 'tour',
        jsonSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          additionalProperties: false,
        },
        migrations: [{ fromVersion: 0, toVersion: 1, up: (d) => d }],
      },
    ]);

    // v is now top-level metadata, not part of data — validation should pass without it
    expect(() => registry.validate('tour', 'is', 'tour', { title: 'test' })).not.toThrow();

    // v in data should be REJECTED by additionalProperties: false
    expect(() => registry.validate('tour', 'is', 'tour', { title: 'test', v: 1 })).toThrow();
  });
});
