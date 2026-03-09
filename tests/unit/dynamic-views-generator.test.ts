import { describe, it, expect } from 'vitest';
import {
  generateDynamicViewsBundle,
  validateTemplate,
  getDynamicViewTags,
} from '../../editor/server/dynamic-views-generator.js';
import type { DynamicTypeMetadata } from '../../editor/server/dynamic-loader.js';

// ---------------------------------------------------------------------------
// validateTemplate
// ---------------------------------------------------------------------------

describe('validateTemplate', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      status: { type: 'string' },
      count: { type: 'number' },
    },
  };

  it('returns no warnings for valid template references', () => {
    const warnings = validateTemplate('{{name}} - {{status}}', schema);
    expect(warnings).toHaveLength(0);
  });

  it('returns warning for unknown field', () => {
    const warnings = validateTemplate('{{name}} {{bogus}}', schema);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bogus');
  });

  it('returns multiple warnings for multiple unknown fields', () => {
    const warnings = validateTemplate('{{foo}} {{bar}} {{name}}', schema);
    expect(warnings).toHaveLength(2);
  });

  it('handles section tags ({{#field}})', () => {
    const warnings = validateTemplate('{{#name}}has name{{/name}}', schema);
    expect(warnings).toHaveLength(0);
  });

  it('warns for unknown section fields', () => {
    const warnings = validateTemplate('{{#items}}item{{/items}}', schema);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('items');
  });

  it('handles inverted sections ({{^field}})', () => {
    const warnings = validateTemplate('{{^status}}no status{{/status}}', schema);
    expect(warnings).toHaveLength(0);
  });

  it('handles unescaped tags ({{&field}})', () => {
    const warnings = validateTemplate('{{&name}}', schema);
    expect(warnings).toHaveLength(0);
  });

  it('handles nested field references (dot notation)', () => {
    // Only checks the top-level field name
    const warnings = validateTemplate('{{name.first}}', schema);
    expect(warnings).toHaveLength(0);
  });

  it('warns for unknown top-level in nested reference', () => {
    const warnings = validateTemplate('{{address.street}}', schema);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('address');
  });

  it('returns empty for undefined schema', () => {
    const warnings = validateTemplate('{{anything}}', undefined);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty for schema without properties', () => {
    const warnings = validateTemplate('{{anything}}', { type: 'object' });
    expect(warnings).toHaveLength(0);
  });

  it('deduplicates field warnings', () => {
    const warnings = validateTemplate('{{bogus}} and {{bogus}} again', schema);
    expect(warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// generateDynamicViewsBundle
// ---------------------------------------------------------------------------

describe('generateDynamicViewsBundle', () => {
  it('returns null when no types have templates', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { tour: {} },
      edges: { hasDeparture: {} },
    };
    expect(generateDynamicViewsBundle(meta)).toBeNull();
  });

  it('generates bundle for node type with viewTemplate', () => {
    const meta: DynamicTypeMetadata = {
      nodes: {
        tour: { viewTemplate: '<div>{{name}}</div>' },
      },
      edges: {},
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).not.toBeNull();
    expect(bundle).toContain('fg-tour-template');
    expect(bundle).toContain('customElements');
    expect(bundle).toContain('_render');
  });

  it('generates bundle for edge type with viewTemplate', () => {
    const meta: DynamicTypeMetadata = {
      nodes: {},
      edges: {
        hasDeparture: { viewTemplate: '<span>{{label}}</span>' },
      },
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).not.toBeNull();
    expect(bundle).toContain('fg-edge-hasdeparture-template');
  });

  it('includes viewCss when provided', () => {
    const meta: DynamicTypeMetadata = {
      nodes: {
        tour: {
          viewTemplate: '<div>{{name}}</div>',
          viewCss: 'div { color: red; }',
        },
      },
      edges: {},
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).not.toBeNull();
    expect(bundle).toContain('CSSStyleSheet');
    expect(bundle).toContain('color: red');
  });

  it('generates multiple elements for multiple types', () => {
    const meta: DynamicTypeMetadata = {
      nodes: {
        tour: { viewTemplate: '<div>{{name}}</div>' },
        agent: { viewTemplate: '<p>{{role}}</p>' },
      },
      edges: {
        assigned: { viewTemplate: '<em>{{since}}</em>' },
      },
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).not.toBeNull();
    expect(bundle).toContain('fg-tour-template');
    expect(bundle).toContain('fg-agent-template');
    expect(bundle).toContain('fg-edge-assigned-template');
  });

  it('includes the mini-Mustache renderer', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { tour: { viewTemplate: '{{name}}' } },
      edges: {},
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).toContain('_esc');
    expect(bundle).toContain('_resolve');
    expect(bundle).toContain('_render');
  });

  it('uses Shadow DOM (attachShadow)', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { tour: { viewTemplate: '{{name}}' } },
      edges: {},
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).toContain('attachShadow');
  });

  it('skips types without viewTemplate', () => {
    const meta: DynamicTypeMetadata = {
      nodes: {
        tour: { viewTemplate: '<div>{{name}}</div>' },
        agent: { viewCss: 'p { color: blue; }' }, // css only, no template
      },
      edges: {},
    };
    const bundle = generateDynamicViewsBundle(meta);
    expect(bundle).toContain('fg-tour-template');
    expect(bundle).not.toContain('fg-agent-template');
  });
});

// ---------------------------------------------------------------------------
// getDynamicViewTags
// ---------------------------------------------------------------------------

describe('getDynamicViewTags', () => {
  it('returns empty maps when no templates', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { tour: {} },
      edges: { hasDeparture: {} },
    };
    const tags = getDynamicViewTags(meta);
    expect(Object.keys(tags.nodes)).toHaveLength(0);
    expect(Object.keys(tags.edges)).toHaveLength(0);
  });

  it('returns tag names for types with templates', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { tour: { viewTemplate: '<div>{{name}}</div>' } },
      edges: { assigned: { viewTemplate: '<span>yes</span>' } },
    };
    const tags = getDynamicViewTags(meta);
    expect(tags.nodes.tour).toBe('fg-tour-template');
    expect(tags.edges.assigned).toBe('fg-edge-assigned-template');
  });

  it('sanitizes special characters in type names', () => {
    const meta: DynamicTypeMetadata = {
      nodes: { 'my-Special_Type': { viewTemplate: '<div>hi</div>' } },
      edges: {},
    };
    const tags = getDynamicViewTags(meta);
    expect(tags.nodes['my-Special_Type']).toBe('fg-my-special-type-template');
  });
});
