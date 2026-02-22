import type { GraphRegistry } from '../../src/types.js';

export interface FieldMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object' | 'unknown';
  required: boolean;
  description?: string;
  enumValues?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  isInt?: boolean;
  itemMeta?: FieldMeta;
  fields?: FieldMeta[];
}

export interface RegistryEntryMeta {
  aType: string;
  abType: string;
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
    const fields = entry.dataSchema ? introspectZodSchema(entry.dataSchema) : [];

    const meta: RegistryEntryMeta = {
      aType: entry.aType,
      abType: entry.abType,
      bType: entry.bType,
      description: entry.description,
      inverseLabel: entry.inverseLabel,
      hasDataSchema: !!entry.dataSchema,
      fields,
      isNodeEntry: entry.abType === 'is',
    };

    if (meta.isNodeEntry) {
      nodeTypes.push(meta);
    } else {
      edgeTypes.push(meta);
    }
  }

  return { nodeTypes, edgeTypes };
}

function introspectZodSchema(
  schema: { parse: (d: unknown) => unknown },
): FieldMeta[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;
  if (!def) return [];

  if (def.typeName === 'ZodObject') {
    return introspectZodObject(def);
  }
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function introspectZodObject(def: any): FieldMeta[] {
  const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
  if (!shape) return [];

  return Object.entries(shape).map(([name, fieldSchema]) => {
    return introspectField(name, fieldSchema);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function introspectField(name: string, schema: any): FieldMeta {
  let inner = schema;
  let required = true;

  // Unwrap ZodOptional / ZodDefault / ZodNullable
  while (inner?._def) {
    const tn = inner._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable') {
      required = false;
      inner = inner._def.innerType;
    } else if (tn === 'ZodDefault') {
      inner = inner._def.innerType;
    } else {
      break;
    }
  }

  const innerDef = inner?._def;
  const typeName = innerDef?.typeName;

  if (typeName === 'ZodString') {
    return {
      name,
      type: 'string',
      required,
      minLength: extractCheck(innerDef, 'min')?.value,
      maxLength: extractCheck(innerDef, 'max')?.value,
      pattern: extractCheck(innerDef, 'regex')?.regex?.source,
    };
  }

  if (typeName === 'ZodNumber') {
    const minCheck = extractCheck(innerDef, 'min');
    const maxCheck = extractCheck(innerDef, 'max');
    return {
      name,
      type: 'number',
      required,
      min: minCheck?.value,
      max: maxCheck?.value,
      isInt: innerDef.checks?.some((c: { kind: string }) => c.kind === 'int'),
    };
  }

  if (typeName === 'ZodBoolean') {
    return { name, type: 'boolean', required };
  }

  if (typeName === 'ZodEnum') {
    return { name, type: 'enum', required, enumValues: innerDef.values };
  }

  if (typeName === 'ZodArray') {
    const itemMeta = introspectField('item', innerDef.type);
    return { name, type: 'array', required, itemMeta };
  }

  if (typeName === 'ZodObject') {
    const fields = introspectZodObject(innerDef);
    return { name, type: 'object', required, fields };
  }

  return { name, type: 'unknown', required };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCheck(def: any, kind: string) {
  return def?.checks?.find((c: { kind: string }) => c.kind === kind);
}
