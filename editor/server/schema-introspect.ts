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

// --- Zod version detection ---
// Zod v3 uses `_def.typeName` (e.g. 'ZodString')
// Zod v4 uses `_def.type` (e.g. 'string') and properties directly on the schema

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTypeName(schema: any): string | undefined {
  const def = schema?._def;
  if (!def) return undefined;
  // v3: _def.typeName = 'ZodString', v4: _def.type = 'string'
  return def.typeName || def.type;
}

function introspectZodSchema(
  schema: { parse: (d: unknown) => unknown },
): FieldMeta[] {
  const tn = getTypeName(schema);
  if (tn === 'ZodObject' || tn === 'object') {
    return introspectZodObject(schema);
  }
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function introspectZodObject(schema: any): FieldMeta[] {
  const def = schema._def;
  // v3: shape can be a function or object, v4: shape is always on _def
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

  // Unwrap optional/default/nullable wrappers (both v3 and v4)
  while (inner?._def) {
    const tn = getTypeName(inner);
    if (tn === 'ZodOptional' || tn === 'optional' || tn === 'ZodNullable' || tn === 'nullable') {
      required = false;
      inner = inner._def.innerType;
    } else if (tn === 'ZodDefault' || tn === 'default') {
      inner = inner._def.innerType;
    } else {
      break;
    }
  }

  const tn = getTypeName(inner);

  if (tn === 'ZodString' || tn === 'string') {
    return {
      name,
      type: 'string',
      required,
      minLength: extractStringMinLength(inner),
      maxLength: extractStringMaxLength(inner),
      pattern: extractStringPattern(inner),
    };
  }

  if (tn === 'ZodNumber' || tn === 'number') {
    return {
      name,
      type: 'number',
      required,
      min: extractNumberMin(inner),
      max: extractNumberMax(inner),
      isInt: extractNumberIsInt(inner),
    };
  }

  if (tn === 'ZodBoolean' || tn === 'boolean') {
    return { name, type: 'boolean', required };
  }

  if (tn === 'ZodEnum' || tn === 'enum') {
    return { name, type: 'enum', required, enumValues: extractEnumValues(inner) };
  }

  if (tn === 'ZodArray' || tn === 'array') {
    // v4: _def.element, v3: _def.type (note: in v4 _def.type is the string 'array')
    const itemSchema = inner._def.element ?? (typeof inner._def.type === 'object' ? inner._def.type : undefined);
    const itemMeta = itemSchema ? introspectField('item', itemSchema) : undefined;
    return { name, type: 'array', required, itemMeta };
  }

  if (tn === 'ZodObject' || tn === 'object') {
    const fields = introspectZodObject(inner);
    return { name, type: 'object', required, fields };
  }

  return { name, type: 'unknown', required };
}

// --- Extraction helpers (handle both v3 and v4) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStringMinLength(schema: any): number | undefined {
  // v4: direct property on schema
  if (schema.minLength != null) return schema.minLength;
  // v3: in _def.checks
  return extractCheck(schema._def, 'min')?.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStringMaxLength(schema: any): number | undefined {
  if (schema.maxLength != null) return schema.maxLength;
  return extractCheck(schema._def, 'max')?.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractStringPattern(schema: any): string | undefined {
  // v4: format === 'regex' indicates regex checks exist, but patterns aren't easily extractable
  // v3: _def.checks with kind 'regex'
  const regexCheck = extractCheck(schema._def, 'regex');
  if (regexCheck?.regex?.source) return regexCheck.regex.source;
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNumberMin(schema: any): number | undefined {
  // v4: direct property
  if (schema.minValue != null) return schema.minValue;
  // v3: in _def.checks
  return extractCheck(schema._def, 'min')?.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNumberMax(schema: any): number | undefined {
  if (schema.maxValue != null) return schema.maxValue;
  return extractCheck(schema._def, 'max')?.value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractNumberIsInt(schema: any): boolean | undefined {
  // v4: direct property
  if (schema.isInt === true) return true;
  // v3: in _def.checks
  if (schema._def?.checks?.some((c: { kind: string }) => c.kind === 'int')) return true;
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEnumValues(schema: any): string[] | undefined {
  // v4: .options array or _def.entries object
  if (Array.isArray(schema.options)) return schema.options;
  // v3: _def.values array
  if (Array.isArray(schema._def?.values)) return schema._def.values;
  // v4 fallback: entries object
  if (schema._def?.entries) return Object.keys(schema._def.entries);
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCheck(def: any, kind: string) {
  return def?.checks?.find((c: { kind: string }) => c.kind === kind);
}
