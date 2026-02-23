import type { GraphRegistry } from '../../src/types.js';
import { jsonSchemaToFieldMeta } from '../../src/json-schema.js';
import type { FieldMeta } from '../../src/json-schema.js';

export type { FieldMeta };

export interface RegistryEntryMeta {
  aType: string;
  axbType: string;
  bType: string;
  description?: string;
  inverseLabel?: string;
  hasDataSchema: boolean;
  fields: FieldMeta[];
  isNodeEntry: boolean;
}

export interface SchemaMetadata {
  nodeTypes: RegistryEntryMeta[];
  edgeTypes: RegistryEntryMeta[];
}

export function introspectRegistry(registry: GraphRegistry): SchemaMetadata {
  const entries = registry.entries();
  const nodeTypes: RegistryEntryMeta[] = [];
  const edgeTypes: RegistryEntryMeta[] = [];

  for (const entry of entries) {
    const fields = entry.jsonSchema
      ? jsonSchemaToFieldMeta(entry.jsonSchema)
      : [];

    const meta: RegistryEntryMeta = {
      aType: entry.aType,
      axbType: entry.axbType,
      bType: entry.bType,
      description: entry.description,
      inverseLabel: entry.inverseLabel,
      hasDataSchema: !!entry.jsonSchema,
      fields,
      isNodeEntry: entry.axbType === 'is',
    };

    if (meta.isNodeEntry) {
      nodeTypes.push(meta);
    } else {
      edgeTypes.push(meta);
    }
  }

  return { nodeTypes, edgeTypes };
}
