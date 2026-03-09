import { describe, it, expect } from 'vitest';
import {
  createBootstrapRegistry,
  createRegistryFromGraph,
  generateDeterministicUid,
  NODE_TYPE_SCHEMA,
  EDGE_TYPE_SCHEMA,
  META_NODE_TYPE,
  META_EDGE_TYPE,
  BOOTSTRAP_ENTRIES,
} from '../../src/dynamic-registry.js';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError, ValidationError } from '../../src/errors.js';
import type { GraphReader, StoredGraphRecord } from '../../src/types.js';
import { Timestamp } from '@google-cloud/firestore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoredRecord(
  aType: string,
  aUid: string,
  data: Record<string, unknown>,
): StoredGraphRecord {
  const now = Timestamp.now();
  return {
    aType,
    aUid,
    axbType: 'is',
    bType: aType,
    bUid: aUid,
    data,
    createdAt: now,
    updatedAt: now,
  };
}

function mockReader(records: StoredGraphRecord[]): GraphReader {
  return {
    async getNode() {
      return null;
    },
    async getEdge() {
      return null;
    },
    async edgeExists() {
      return false;
    },
    async findEdges() {
      return [];
    },
    async findNodes(params) {
      return records.filter((r) => r.aType === params.aType);
    },
  };
}

// ---------------------------------------------------------------------------
// NODE_TYPE_SCHEMA
// ---------------------------------------------------------------------------

describe('NODE_TYPE_SCHEMA', () => {
  const registry = createRegistry([
    { aType: 'nodeType', axbType: 'is', bType: 'nodeType', jsonSchema: NODE_TYPE_SCHEMA },
  ]);

  it('validates correct nodeType data', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
      }),
    ).not.toThrow();
  });

  it('accepts optional description', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
        description: 'A guided tour',
      }),
    ).not.toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        jsonSchema: { type: 'object' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects missing jsonSchema', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects extra properties', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
        extra: true,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects empty name', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: '',
        jsonSchema: { type: 'object' },
      }),
    ).toThrow(ValidationError);
  });

  it('accepts optional titleField and subtitleField', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
        titleField: 'name',
        subtitleField: 'status',
      }),
    ).not.toThrow();
  });

  it('accepts optional viewTemplate and viewCss', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
        viewTemplate: '<div>{{name}}</div>',
        viewCss: 'div { color: red; }',
      }),
    ).not.toThrow();
  });

  it('accepts all optional fields together', () => {
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
        description: 'A tour',
        titleField: 'name',
        subtitleField: 'status',
        viewTemplate: '<h1>{{name}}</h1>',
        viewCss: 'h1 { font-size: 2em; }',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_SCHEMA
// ---------------------------------------------------------------------------

describe('EDGE_TYPE_SCHEMA', () => {
  const registry = createRegistry([
    { aType: 'edgeType', axbType: 'is', bType: 'edgeType', jsonSchema: EDGE_TYPE_SCHEMA },
  ]);

  it('validates correct edgeType data with string from/to', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
      }),
    ).not.toThrow();
  });

  it('validates correct edgeType data with array from/to', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'connects',
        from: ['task', 'project'],
        to: ['step'],
      }),
    ).not.toThrow();
  });

  it('accepts optional jsonSchema, inverseLabel, description', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        jsonSchema: { type: 'object' },
        inverseLabel: 'departureOf',
        description: 'Tours have departures',
      }),
    ).not.toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        from: 'tour',
        to: 'departure',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects missing from', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        to: 'departure',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects missing to', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects extra properties', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        extra: true,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects empty from array', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: [],
        to: 'departure',
      }),
    ).toThrow(ValidationError);
  });

  it('accepts optional titleField and subtitleField', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        titleField: 'label',
        subtitleField: 'since',
      }),
    ).not.toThrow();
  });

  it('accepts optional viewTemplate and viewCss', () => {
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        viewTemplate: '<span>{{label}}</span>',
        viewCss: 'span { color: blue; }',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createBootstrapRegistry
// ---------------------------------------------------------------------------

describe('createBootstrapRegistry', () => {
  it('returns a valid GraphRegistry', () => {
    const registry = createBootstrapRegistry();
    expect(registry.validate).toBeTypeOf('function');
    expect(registry.lookup).toBeTypeOf('function');
    expect(registry.entries).toBeTypeOf('function');
  });

  it('includes exactly 2 entries (nodeType + edgeType)', () => {
    const registry = createBootstrapRegistry();
    expect(registry.entries()).toHaveLength(2);
  });

  it('validates nodeType writes', () => {
    const registry = createBootstrapRegistry();
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'tour',
        jsonSchema: { type: 'object' },
      }),
    ).not.toThrow();
  });

  it('validates edgeType writes', () => {
    const registry = createBootstrapRegistry();
    expect(() =>
      registry.validate('edgeType', 'is', 'edgeType', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
      }),
    ).not.toThrow();
  });

  it('rejects unknown domain types', () => {
    const registry = createBootstrapRegistry();
    expect(() =>
      registry.validate('tour', 'is', 'tour', { name: 'X' }),
    ).toThrow(RegistryViolationError);
  });
});

// ---------------------------------------------------------------------------
// generateDeterministicUid
// ---------------------------------------------------------------------------

describe('generateDeterministicUid', () => {
  it('produces consistent UID for same input', () => {
    const uid1 = generateDeterministicUid(META_NODE_TYPE, 'tour');
    const uid2 = generateDeterministicUid(META_NODE_TYPE, 'tour');
    expect(uid1).toBe(uid2);
  });

  it('produces different UIDs for different names', () => {
    const uid1 = generateDeterministicUid(META_NODE_TYPE, 'tour');
    const uid2 = generateDeterministicUid(META_NODE_TYPE, 'departure');
    expect(uid1).not.toBe(uid2);
  });

  it('produces 21-character strings', () => {
    const uid = generateDeterministicUid(META_NODE_TYPE, 'tour');
    expect(uid).toHaveLength(21);
  });

  it('produces different UIDs for nodeType vs edgeType with same name', () => {
    const uid1 = generateDeterministicUid(META_NODE_TYPE, 'hasDeparture');
    const uid2 = generateDeterministicUid(META_EDGE_TYPE, 'hasDeparture');
    expect(uid1).not.toBe(uid2);
  });
});

// ---------------------------------------------------------------------------
// BOOTSTRAP_ENTRIES
// ---------------------------------------------------------------------------

describe('BOOTSTRAP_ENTRIES', () => {
  it('has exactly 2 entries', () => {
    expect(BOOTSTRAP_ENTRIES).toHaveLength(2);
  });

  it('first entry is nodeType self-loop', () => {
    const entry = BOOTSTRAP_ENTRIES[0];
    expect(entry.aType).toBe('nodeType');
    expect(entry.axbType).toBe('is');
    expect(entry.bType).toBe('nodeType');
    expect(entry.jsonSchema).toBe(NODE_TYPE_SCHEMA);
  });

  it('second entry is edgeType self-loop', () => {
    const entry = BOOTSTRAP_ENTRIES[1];
    expect(entry.aType).toBe('edgeType');
    expect(entry.axbType).toBe('is');
    expect(entry.bType).toBe('edgeType');
    expect(entry.jsonSchema).toBe(EDGE_TYPE_SCHEMA);
  });
});

// ---------------------------------------------------------------------------
// createRegistryFromGraph
// ---------------------------------------------------------------------------

describe('createRegistryFromGraph', () => {
  it('returns bootstrap-only registry for empty graph', async () => {
    const reader = mockReader([]);
    const registry = await createRegistryFromGraph(reader);

    expect(registry.entries()).toHaveLength(2); // just bootstrap
    expect(registry.lookup('nodeType', 'is', 'nodeType')).toBeDefined();
    expect(registry.lookup('edgeType', 'is', 'edgeType')).toBeDefined();
  });

  it('compiles nodeType records into self-loop entries', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'tour',
        jsonSchema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        description: 'A guided tour',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    const entry = registry.lookup('tour', 'is', 'tour');
    expect(entry).toBeDefined();
    expect(entry!.description).toBe('A guided tour');

    // Validates data against the compiled schema
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'Dolomites' })).not.toThrow();
    expect(() => registry.validate('tour', 'is', 'tour', { name: 123 })).toThrow(ValidationError);
  });

  it('compiles edgeType records into expanded entries', async () => {
    const reader = mockReader([
      makeStoredRecord('edgeType', 'uid2', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        inverseLabel: 'departureOf',
        description: 'Tours have departures',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    const entry = registry.lookup('tour', 'hasDeparture', 'departure');
    expect(entry).toBeDefined();
    expect(entry!.inverseLabel).toBe('departureOf');
    expect(entry!.description).toBe('Tours have departures');
  });

  it('handles edgeType with array from/to (cross-product)', async () => {
    const reader = mockReader([
      makeStoredRecord('edgeType', 'uid3', {
        name: 'connects',
        from: ['a', 'b'],
        to: ['c', 'd'],
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    // Cross-product: a→c, a→d, b→c, b→d
    expect(registry.lookup('a', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('a', 'connects', 'd')).toBeDefined();
    expect(registry.lookup('b', 'connects', 'c')).toBeDefined();
    expect(registry.lookup('b', 'connects', 'd')).toBeDefined();
    // Not defined
    expect(registry.lookup('a', 'connects', 'b')).toBeUndefined();
  });

  it('always includes bootstrap entries in output', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'tour',
        jsonSchema: { type: 'object' },
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    // Bootstrap types still validateable
    expect(() =>
      registry.validate('nodeType', 'is', 'nodeType', {
        name: 'another',
        jsonSchema: { type: 'object' },
      }),
    ).not.toThrow();
  });

  it('validates domain types after compilation', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'tour',
        jsonSchema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    expect(() => registry.validate('tour', 'is', 'tour', { bad: true })).toThrow(ValidationError);
  });

  it('rejects unknown domain types', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'tour',
        jsonSchema: { type: 'object' },
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    expect(() => registry.validate('booking', 'is', 'booking', {})).toThrow(
      RegistryViolationError,
    );
  });

  it('threads titleField and subtitleField through to nodeType entries', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'tour',
        jsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
        titleField: 'name',
        subtitleField: 'status',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    const entry = registry.lookup('tour', 'is', 'tour');
    expect(entry).toBeDefined();
    expect(entry!.titleField).toBe('name');
    expect(entry!.subtitleField).toBe('status');
  });

  it('threads titleField and subtitleField through to edgeType entries', async () => {
    const reader = mockReader([
      makeStoredRecord('edgeType', 'uid2', {
        name: 'hasDeparture',
        from: 'tour',
        to: 'departure',
        titleField: 'label',
        subtitleField: 'date',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    const entry = registry.lookup('tour', 'hasDeparture', 'departure');
    expect(entry).toBeDefined();
    expect(entry!.titleField).toBe('label');
    expect(entry!.subtitleField).toBe('date');
  });

  it('handles edgeType with optional jsonSchema', async () => {
    const reader = mockReader([
      makeStoredRecord('edgeType', 'uid2', {
        name: 'follows',
        from: 'user',
        to: 'user',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    const entry = registry.lookup('user', 'follows', 'user');
    expect(entry).toBeDefined();
    expect(entry!.jsonSchema).toBeUndefined();

    // No schema means any data is accepted
    expect(() => registry.validate('user', 'follows', 'user', { anything: true })).not.toThrow();
  });

  it('compiles multiple nodeTypes and edgeTypes together', async () => {
    const reader = mockReader([
      makeStoredRecord('nodeType', 'uid1', {
        name: 'user',
        jsonSchema: { type: 'object', properties: { email: { type: 'string' } } },
      }),
      makeStoredRecord('nodeType', 'uid2', {
        name: 'task',
        jsonSchema: { type: 'object', properties: { title: { type: 'string' } } },
      }),
      makeStoredRecord('edgeType', 'uid3', {
        name: 'assignedTo',
        from: 'task',
        to: 'user',
        inverseLabel: 'assignee',
      }),
    ]);
    const registry = await createRegistryFromGraph(reader);

    expect(registry.lookup('user', 'is', 'user')).toBeDefined();
    expect(registry.lookup('task', 'is', 'task')).toBeDefined();
    expect(registry.lookup('task', 'assignedTo', 'user')).toBeDefined();
    expect(registry.lookup('task', 'assignedTo', 'user')!.inverseLabel).toBe('assignee');

    // Total: 2 bootstrap + 2 nodeTypes + 1 edgeType = 5
    expect(registry.entries()).toHaveLength(5);
  });
});
