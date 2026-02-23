import { describe, it, expect } from 'vitest';
import { createRegistry } from '../../src/registry.js';
import { validateSchemaViews } from '../../editor/server/schema-views-validator.js';
import type { SchemaMetadata } from '../../editor/server/schema-introspect.js';
import type { ViewRegistry, EntityViewMeta } from '../../src/views.js';
import type { LoadedConfig } from '../../editor/server/config-loader.js';

// --- Helpers ---

function makeSchemaMetadata(
  nodeATypes: string[],
  edgeAbTypes: { aType: string; abType: string; bType: string }[],
): SchemaMetadata {
  return {
    nodeTypes: nodeATypes.map((aType) => ({
      aType,
      abType: 'is',
      bType: aType,
      hasDataSchema: true,
      fields: [],
      isNodeEntry: true,
    })),
    edgeTypes: edgeAbTypes.map((e) => ({
      aType: e.aType,
      abType: e.abType,
      bType: e.bType,
      hasDataSchema: true,
      fields: [],
      isNodeEntry: false,
    })),
  };
}

function makeViewMeta(viewName: string): EntityViewMeta {
  return {
    views: [{ tagName: `fg-test-${viewName}`, viewName, description: `${viewName} view` }],
  };
}

function makeViewMetaMulti(viewNames: string[]): EntityViewMeta {
  return {
    views: viewNames.map((name) => ({
      tagName: `fg-test-${name}`,
      viewName: name,
      description: `${name} view`,
    })),
  };
}

const tourJsonSchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' } },
};

const tourJsonSchemaWithNumber = {
  type: 'object',
  required: ['name', 'maxRiders'],
  properties: {
    name: { type: 'string' },
    maxRiders: { type: 'number' },
  },
};

const edgeJsonSchema = {
  type: 'object',
  required: ['order'],
  properties: { order: { type: 'number' } },
};

// --- Tests ---

describe('validateSchemaViews', () => {
  describe('null / empty inputs', () => {
    it('returns empty array when viewRegistry is null', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const result = validateSchemaViews(schema, null, null, registry);
      expect(result).toEqual([]);
    });

    it('returns empty array when views match registry exactly', () => {
      const schema = makeSchemaMetadata(['tour'], [{ aType: 'tour', abType: 'hasDeparture', bType: 'departure' }]);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
        { aType: 'tour', abType: 'hasDeparture', bType: 'departure' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMeta('card') },
        edges: { hasDeparture: makeViewMeta('timeline') },
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toEqual([]);
    });
  });

  describe('orphaned views', () => {
    it('detects node views for types not in registry', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {
          tour: makeViewMeta('card'),
          ghost: makeViewMeta('card'),
        },
        edges: {},
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('ORPHANED_NODE_VIEW');
      expect(result[0].entityType).toBe('ghost');
      expect(result[0].entityKind).toBe('node');
    });

    it('detects edge views for abTypes not in registry', () => {
      const schema = makeSchemaMetadata([], [{ aType: 'tour', abType: 'hasDeparture', bType: 'departure' }]);
      const registry = createRegistry([
        { aType: 'tour', abType: 'hasDeparture', bType: 'departure' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {},
        edges: {
          hasDeparture: makeViewMeta('timeline'),
          friendsWith: makeViewMeta('card'),
        },
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('ORPHANED_EDGE_VIEW');
      expect(result[0].entityType).toBe('friendsWith');
    });
  });

  describe('sample data validation', () => {
    it('passes when sample data matches schema', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour', jsonSchema: tourJsonSchema },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {
          tour: {
            views: [{ tagName: 'fg-tour-card', viewName: 'card' }],
            sampleData: { name: 'Dolomites' },
          },
        },
        edges: {},
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toEqual([]);
    });

    it('emits warning for invalid sample data', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour', jsonSchema: tourJsonSchemaWithNumber },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {
          tour: {
            views: [{ tagName: 'fg-tour-card', viewName: 'card' }],
            sampleData: { name: 123, maxRiders: 'not a number' },
          },
        },
        edges: {},
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      const invalid = result.filter((w) => w.code === 'SAMPLE_DATA_INVALID');
      expect(invalid).toHaveLength(1);
      expect(invalid[0].entityType).toBe('tour');
      expect(invalid[0].severity).toBe('warn');
    });

    it('validates edge sample data against JSON schema', () => {
      const schema = makeSchemaMetadata([], [{ aType: 'tour', abType: 'hasDeparture', bType: 'departure' }]);
      const registry = createRegistry([
        { aType: 'tour', abType: 'hasDeparture', bType: 'departure', jsonSchema: edgeJsonSchema },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {},
        edges: {
          hasDeparture: {
            views: [{ tagName: 'fg-edge-hasdeparture-timeline', viewName: 'timeline' }],
            sampleData: { order: 'first' },
          },
        },
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('SAMPLE_DATA_INVALID');
      expect(result[0].entityKind).toBe('edge');
    });

    it('skips validation when no jsonSchema exists', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {
          tour: {
            views: [{ tagName: 'fg-tour-card', viewName: 'card' }],
            sampleData: { anything: 'goes' },
          },
        },
        edges: {},
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toEqual([]);
    });
  });

  describe('viewDefaults validation', () => {
    it('passes when all defaults reference valid views', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMetaMulti(['card', 'detail']) },
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'card' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toEqual([]);
    });

    it('detects default view name not in view list', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMeta('card') },
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'timeline' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('VIEW_DEFAULT_UNKNOWN');
      expect(result[0].viewName).toBe('timeline');
    });

    it('allows "json" as default without warning', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMeta('card') },
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'json' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toEqual([]);
    });

    it('detects viewDefaults for entity types with no views', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {},
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'card' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('VIEW_DEFAULT_ORPHANED');
      expect(result[0].entityType).toBe('tour');
    });

    it('skips when viewDefaults is null', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMeta('card') },
        edges: {},
      };
      const result = validateSchemaViews(schema, viewReg, null, registry);
      expect(result).toEqual([]);
    });

    it('validates edge viewDefaults', () => {
      const schema = makeSchemaMetadata([], [{ aType: 'tour', abType: 'hasDeparture', bType: 'departure' }]);
      const registry = createRegistry([
        { aType: 'tour', abType: 'hasDeparture', bType: 'departure' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {},
        edges: { hasDeparture: makeViewMeta('timeline') },
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        edges: { hasDeparture: { default: 'nonexistent' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe('VIEW_DEFAULT_UNKNOWN');
      expect(result[0].entityKind).toBe('edge');
    });

    it('detects context-specific keys referencing unknown views', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMeta('card') },
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'card', listing: 'row', detail: 'nonexistent' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      // 'row' and 'nonexistent' are both not in ['card']
      const unknown = result.filter((w) => w.code === 'VIEW_DEFAULT_UNKNOWN');
      expect(unknown).toHaveLength(2);
      expect(unknown.map((w) => w.viewName).sort()).toEqual(['nonexistent', 'row']);
    });

    it('allows valid context-specific keys', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour' },
      ]);
      const viewReg: ViewRegistry = {
        nodes: { tour: makeViewMetaMulti(['card', 'detail']) },
        edges: {},
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'card', listing: 'card', detail: 'detail', inline: 'card' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      expect(result).toEqual([]);
    });
  });

  describe('multiple warnings', () => {
    it('accumulates warnings from all checks', () => {
      const schema = makeSchemaMetadata(['tour'], []);
      const registry = createRegistry([
        { aType: 'tour', abType: 'is', bType: 'tour', jsonSchema: tourJsonSchema },
      ]);
      const viewReg: ViewRegistry = {
        nodes: {
          tour: {
            views: [{ tagName: 'fg-tour-card', viewName: 'card' }],
            sampleData: { name: 123 },
          },
          ghost: makeViewMeta('card'),
        },
        edges: {
          unknownEdge: makeViewMeta('timeline'),
        },
      };
      const viewDefaults: LoadedConfig['viewDefaults'] = {
        nodes: { tour: { default: 'nonexistent' } },
      };
      const result = validateSchemaViews(schema, viewReg, viewDefaults, registry);
      const codes = result.map((w) => w.code);
      expect(codes).toContain('ORPHANED_NODE_VIEW');
      expect(codes).toContain('ORPHANED_EDGE_VIEW');
      expect(codes).toContain('SAMPLE_DATA_INVALID');
      expect(codes).toContain('VIEW_DEFAULT_UNKNOWN');
      expect(result.length).toBeGreaterThanOrEqual(4);
    });
  });
});
