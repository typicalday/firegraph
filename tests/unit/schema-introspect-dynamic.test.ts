import { describe, it, expect } from 'vitest';
import { introspectRegistry } from '../../editor/server/schema-introspect.js';
import { createRegistry } from '../../src/registry.js';

describe('introspectRegistry — isDynamic tagging', () => {
  const entries = [
    // Static node
    {
      aType: 'tour',
      axbType: 'is',
      bType: 'tour',
      jsonSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    // Dynamic node
    {
      aType: 'agent',
      axbType: 'is',
      bType: 'agent',
      jsonSchema: { type: 'object', properties: { role: { type: 'string' } } },
    },
    // Static edge
    {
      aType: 'tour',
      axbType: 'hasDeparture',
      bType: 'departure',
    },
    // Dynamic edge
    {
      aType: 'agent',
      axbType: 'assignedTo',
      bType: 'tour',
    },
  ];

  const registry = createRegistry(entries);

  it('without dynamicNames, isDynamic is undefined for all entries', () => {
    const meta = introspectRegistry(registry);
    for (const n of meta.nodeTypes) {
      expect(n.isDynamic).toBeUndefined();
    }
    for (const e of meta.edgeTypes) {
      expect(e.isDynamic).toBeUndefined();
    }
  });

  it('tags node types correctly based on dynamicNames', () => {
    const dynamicNames = new Set(['agent', 'assignedTo']);
    const meta = introspectRegistry(registry, dynamicNames);

    const tourNode = meta.nodeTypes.find(n => n.aType === 'tour');
    const agentNode = meta.nodeTypes.find(n => n.aType === 'agent');

    expect(tourNode?.isDynamic).toBe(false);
    expect(agentNode?.isDynamic).toBe(true);
  });

  it('tags edge types correctly based on dynamicNames', () => {
    const dynamicNames = new Set(['agent', 'assignedTo']);
    const meta = introspectRegistry(registry, dynamicNames);

    const hasDeparture = meta.edgeTypes.find(e => e.axbType === 'hasDeparture');
    const assignedTo = meta.edgeTypes.find(e => e.axbType === 'assignedTo');

    expect(hasDeparture?.isDynamic).toBe(false);
    expect(assignedTo?.isDynamic).toBe(true);
  });

  it('nodes use aType for dynamic name lookup', () => {
    // Even though a node entry has axbType='is', isDynamic checks aType
    const dynamicNames = new Set(['tour']);
    const meta = introspectRegistry(registry, dynamicNames);

    const tourNode = meta.nodeTypes.find(n => n.aType === 'tour');
    expect(tourNode?.isDynamic).toBe(true);
  });

  it('edges use axbType for dynamic name lookup', () => {
    const dynamicNames = new Set(['hasDeparture']);
    const meta = introspectRegistry(registry, dynamicNames);

    const hasDeparture = meta.edgeTypes.find(e => e.axbType === 'hasDeparture');
    expect(hasDeparture?.isDynamic).toBe(true);

    // agent should NOT be tagged since 'agent' is not in dynamicNames
    const agentNode = meta.nodeTypes.find(n => n.aType === 'agent');
    expect(agentNode?.isDynamic).toBe(false);
  });

  it('empty dynamicNames set marks everything as false', () => {
    const dynamicNames = new Set<string>();
    const meta = introspectRegistry(registry, dynamicNames);

    for (const n of meta.nodeTypes) {
      expect(n.isDynamic).toBe(false);
    }
    for (const e of meta.edgeTypes) {
      expect(e.isDynamic).toBe(false);
    }
  });

  it('preserves other metadata fields alongside isDynamic', () => {
    const dynamicNames = new Set(['agent']);
    const meta = introspectRegistry(registry, dynamicNames);

    const agentNode = meta.nodeTypes.find(n => n.aType === 'agent');
    expect(agentNode).toBeDefined();
    expect(agentNode!.isDynamic).toBe(true);
    expect(agentNode!.isNodeEntry).toBe(true);
    expect(agentNode!.hasDataSchema).toBe(true);
    expect(agentNode!.fields.length).toBeGreaterThan(0);
  });
});
