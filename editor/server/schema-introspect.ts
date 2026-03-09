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
  titleField?: string;
  subtitleField?: string;
  hasDataSchema: boolean;
  fields: FieldMeta[];
  isNodeEntry: boolean;
  /** True if this type was loaded from the dynamic registry (Firestore meta-nodes). */
  isDynamic?: boolean;
}

export interface SchemaMetadata {
  nodeTypes: RegistryEntryMeta[];
  edgeTypes: RegistryEntryMeta[];
}

/**
 * Convert a GraphRegistry into SchemaMetadata for the editor frontend.
 *
 * @param registry - The compiled registry to introspect.
 * @param dynamicNames - Optional set of type names that came from the dynamic registry.
 *   Node types are identified by aType, edge types by axbType.
 */
export function introspectRegistry(
  registry: GraphRegistry,
  dynamicNames?: Set<string>,
): SchemaMetadata {
  const entries = registry.entries();
  const nodeTypes: RegistryEntryMeta[] = [];
  const edgeTypes: RegistryEntryMeta[] = [];

  for (const entry of entries) {
    const fields = entry.jsonSchema
      ? jsonSchemaToFieldMeta(entry.jsonSchema)
      : [];

    const isNode = entry.axbType === 'is';
    const isDynamic = dynamicNames
      ? dynamicNames.has(isNode ? entry.aType : entry.axbType)
      : undefined;

    const meta: RegistryEntryMeta = {
      aType: entry.aType,
      axbType: entry.axbType,
      bType: entry.bType,
      description: entry.description,
      inverseLabel: entry.inverseLabel,
      titleField: entry.titleField,
      subtitleField: entry.subtitleField,
      hasDataSchema: !!entry.jsonSchema,
      fields,
      isNodeEntry: isNode,
      isDynamic,
    };

    if (meta.isNodeEntry) {
      nodeTypes.push(meta);
    } else {
      edgeTypes.push(meta);
    }
  }

  return { nodeTypes, edgeTypes };
}
