import { compileSchema } from '../../src/json-schema.js';
import type { GraphRegistry } from '../../src/types.js';
import type { ViewRegistry } from '../../src/views.js';
import type { LoadedConfig } from './config-loader.js';
import type { SchemaMetadata } from './schema-introspect.js';

export type SchemaViewWarningCode =
  | 'ORPHANED_NODE_VIEW'
  | 'ORPHANED_EDGE_VIEW'
  | 'SAMPLE_DATA_INVALID'
  | 'VIEW_DEFAULT_UNKNOWN'
  | 'VIEW_DEFAULT_ORPHANED';

export interface SchemaViewWarning {
  code: SchemaViewWarningCode;
  severity: 'warn' | 'info';
  message: string;
  entityType: string;
  entityKind: 'node' | 'edge';
  viewName?: string;
}

export function validateSchemaViews(
  schemaMetadata: SchemaMetadata,
  viewRegistry: ViewRegistry | null,
  viewDefaults: LoadedConfig['viewDefaults'] | null,
  registry: GraphRegistry,
): SchemaViewWarning[] {
  if (!viewRegistry) return [];

  const warnings: SchemaViewWarning[] = [];

  const knownNodeTypes = new Set(schemaMetadata.nodeTypes.map((n) => n.aType));
  const knownEdgeAxbTypes = new Set(schemaMetadata.edgeTypes.map((e) => e.axbType));

  // 1. Orphaned node views
  for (const entityType of Object.keys(viewRegistry.nodes)) {
    if (!knownNodeTypes.has(entityType)) {
      warnings.push({
        code: 'ORPHANED_NODE_VIEW',
        severity: 'warn',
        message: `Node view registered for "${entityType}" but no matching node type exists in the registry.`,
        entityType,
        entityKind: 'node',
      });
    }
  }

  // 2. Orphaned edge views
  for (const axbType of Object.keys(viewRegistry.edges)) {
    if (!knownEdgeAxbTypes.has(axbType)) {
      warnings.push({
        code: 'ORPHANED_EDGE_VIEW',
        severity: 'warn',
        message: `Edge view registered for "${axbType}" but no matching edge type exists in the registry.`,
        entityType: axbType,
        entityKind: 'edge',
      });
    }
  }

  // 3. Sample data validation
  validateSampleData(viewRegistry.nodes, 'node', registry, warnings);
  validateSampleData(viewRegistry.edges, 'edge', registry, warnings);

  // 4. viewDefaults reference checks
  if (viewDefaults) {
    validateViewDefaults(viewDefaults.nodes, 'node', viewRegistry.nodes, warnings);
    validateViewDefaults(viewDefaults.edges, 'edge', viewRegistry.edges, warnings);
  }

  return warnings;
}

function validateSampleData(
  entities: ViewRegistry['nodes'] | ViewRegistry['edges'],
  kind: 'node' | 'edge',
  registry: GraphRegistry,
  warnings: SchemaViewWarning[],
): void {
  for (const [entityType, meta] of Object.entries(entities)) {
    if (!meta.sampleData) continue;

    // Find the registry entry to get the JSON Schema
    const entry =
      kind === 'node'
        ? registry.lookup(entityType, 'is', entityType)
        : findEdgeEntry(registry, entityType);

    if (entry?.jsonSchema) {
      try {
        const validate = compileSchema(entry.jsonSchema);
        validate(meta.sampleData);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        warnings.push({
          code: 'SAMPLE_DATA_INVALID',
          severity: 'warn',
          message: `Sample data for ${kind} "${entityType}" fails schema validation: ${detail}`,
          entityType,
          entityKind: kind,
        });
      }
    }
  }
}

const VIEW_CONTEXT_KEYS = ['listing', 'detail', 'inline'] as const;

function validateViewDefaults(
  defaults:
    | Record<string, { default?: string; listing?: string; detail?: string; inline?: string }>
    | undefined,
  kind: 'node' | 'edge',
  viewEntities: ViewRegistry['nodes'] | ViewRegistry['edges'],
  warnings: SchemaViewWarning[],
): void {
  if (!defaults) return;

  for (const [entityType, config] of Object.entries(defaults)) {
    const entityViews = viewEntities[entityType];

    if (!entityViews || entityViews.views.length === 0) {
      warnings.push({
        code: 'VIEW_DEFAULT_ORPHANED',
        severity: 'warn',
        message: `viewDefaults references ${kind} "${entityType}" but no views are registered for it.`,
        entityType,
        entityKind: kind,
      });
      continue;
    }

    const availableNames = new Set(entityViews.views.map((v) => v.viewName));

    if (config.default && config.default !== 'json' && !availableNames.has(config.default)) {
      warnings.push({
        code: 'VIEW_DEFAULT_UNKNOWN',
        severity: 'warn',
        message: `viewDefaults.${kind}s.${entityType}.default references view "${config.default}" which is not registered. Available: ${[...availableNames].join(', ')}.`,
        entityType,
        entityKind: kind,
        viewName: config.default,
      });
    }

    // Validate context-specific default keys (listing, detail, inline)
    for (const ctx of VIEW_CONTEXT_KEYS) {
      const ctxView = config[ctx];
      if (ctxView && ctxView !== 'json' && !availableNames.has(ctxView)) {
        warnings.push({
          code: 'VIEW_DEFAULT_UNKNOWN',
          severity: 'warn',
          message: `viewDefaults.${kind}s.${entityType}.${ctx} references view "${ctxView}" which is not registered. Available: ${[...availableNames].join(', ')}.`,
          entityType,
          entityKind: kind,
          viewName: ctxView,
        });
      }
    }
  }
}

function findEdgeEntry(
  registry: GraphRegistry,
  axbType: string,
): { jsonSchema?: object } | undefined {
  for (const entry of registry.entries()) {
    if (entry.axbType === axbType && entry.axbType !== 'is') {
      return entry;
    }
  }
  return undefined;
}
