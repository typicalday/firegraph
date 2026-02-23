/**
 * JSON Schema validation and introspection utilities.
 *
 * Standard JSON Schema validation and introspection
 * processing. Uses ajv for validation and a recursive walker for converting
 * JSON Schema properties into FieldMeta objects for editor form generation.
 */

import Ajv from 'ajv';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// FieldMeta types (previously in editor/server/schema-introspect.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compile a JSON Schema into a validation function.
 * The returned function throws `ValidationError` if data is invalid.
 */
export function compileSchema(
  schema: object,
  label?: string,
): (data: unknown) => void {
  const validate = ajv.compile(schema);
  return (data: unknown) => {
    if (!validate(data)) {
      const errors = validate.errors ?? [];
      const messages = errors
        .map((err) => `${err.instancePath || '/'}${err.message ? ': ' + err.message : ''}`)
        .join('; ');
      throw new ValidationError(
        `Data validation failed${label ? ' for ' + label : ''}: ${messages}`,
        errors,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// JSON Schema → FieldMeta introspection
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Convert a JSON Schema (expected to be `type: "object"`) into `FieldMeta[]`
 * suitable for the editor's SchemaForm component.
 */
export function jsonSchemaToFieldMeta(schema: any): FieldMeta[] {
  if (!schema || schema.type !== 'object' || !schema.properties) return [];

  const requiredSet = new Set<string>(
    Array.isArray(schema.required) ? schema.required : [],
  );

  return Object.entries(schema.properties).map(([name, prop]) =>
    propertyToFieldMeta(name, prop as any, requiredSet.has(name)),
  );
}

/**
 * Convert a single JSON Schema property into a `FieldMeta`.
 */
function propertyToFieldMeta(
  name: string,
  prop: any,
  required: boolean,
): FieldMeta {
  if (!prop) return { name, type: 'unknown', required };

  // Handle enum (can appear with or without type)
  if (Array.isArray(prop.enum)) {
    return {
      name,
      type: 'enum',
      required,
      enumValues: prop.enum as string[],
      description: prop.description,
    };
  }

  // Handle oneOf/anyOf for nullable patterns like { oneOf: [{type:'string'}, {type:'null'}] }
  if (Array.isArray(prop.oneOf) || Array.isArray(prop.anyOf)) {
    const variants = (prop.oneOf ?? prop.anyOf) as any[];
    const nonNull = variants.filter((v: any) => v.type !== 'null');
    if (nonNull.length === 1) {
      // Nullable wrapper — unwrap and mark as optional
      return propertyToFieldMeta(name, nonNull[0], false);
    }
    return { name, type: 'unknown', required, description: prop.description };
  }

  const type = prop.type;

  if (type === 'string') {
    return {
      name,
      type: 'string',
      required,
      minLength: prop.minLength,
      maxLength: prop.maxLength,
      pattern: prop.pattern,
      description: prop.description,
    };
  }

  if (type === 'number' || type === 'integer') {
    return {
      name,
      type: 'number',
      required,
      min: prop.minimum,
      max: prop.maximum,
      isInt: type === 'integer' ? true : undefined,
      description: prop.description,
    };
  }

  if (type === 'boolean') {
    return { name, type: 'boolean', required, description: prop.description };
  }

  if (type === 'array') {
    const itemMeta = prop.items
      ? propertyToFieldMeta('item', prop.items, true)
      : undefined;
    return {
      name,
      type: 'array',
      required,
      itemMeta,
      description: prop.description,
    };
  }

  if (type === 'object') {
    return {
      name,
      type: 'object',
      required,
      fields: jsonSchemaToFieldMeta(prop),
      description: prop.description,
    };
  }

  return { name, type: 'unknown', required, description: prop.description };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
