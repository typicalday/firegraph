/**
 * JSON Schema validation and introspection utilities.
 *
 * Uses `@cfworker/json-schema` for validation — a runtime-interpreter
 * JSON Schema validator that does not rely on `new Function()` and is
 * therefore compatible with Cloudflare Workers (which run V8 with
 * `--disallow-code-generation-from-strings`). Ajv was used here
 * previously, but its `ajv.compile(schema)` generates a validator via
 * the Function constructor and fails with "Code generation from strings
 * disallowed for this context" whenever firegraph's dynamic-registry
 * bootstrap or `reloadRegistry` runs inside a Worker.
 *
 * The introspection half (`jsonSchemaToFieldMeta`) is pure string/object
 * manipulation with no validator dependency.
 */

import { type OutputUnit, type Schema, Validator } from '@cfworker/json-schema';

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

/**
 * Compile a JSON Schema into a validation function.
 *
 * The returned function throws `ValidationError` if data is invalid. The
 * error's `details` is the `OutputUnit[]` array produced by
 * `@cfworker/json-schema` — consumers that previously inspected Ajv's
 * `ErrorObject[]` need to map to the cfworker shape
 * (`{ keyword, keywordLocation, instanceLocation, error }`).
 *
 * Draft 2020-12 is requested by default to match the library's richest
 * feature set; schemas that omit `$schema` still validate under it
 * since keyword semantics back-compat to draft-07 for the fields
 * firegraph actually uses.
 */
export function compileSchema(schema: object, label?: string): (data: unknown) => void {
  const validator = new Validator(schema as Schema, '2020-12');
  return (data: unknown) => {
    const result = validator.validate(data);
    if (!result.valid) {
      const messages = result.errors
        .map(
          (err: OutputUnit) => `${err.instanceLocation || '/'}${err.error ? ': ' + err.error : ''}`,
        )
        .join('; ');
      throw new ValidationError(
        `Data validation failed${label ? ' for ' + label : ''}: ${messages}`,
        result.errors,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// JSON Schema → FieldMeta introspection
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema (expected to be `type: "object"`) into `FieldMeta[]`
 * suitable for the editor's SchemaForm component.
 */
export function jsonSchemaToFieldMeta(schema: any): FieldMeta[] {
  if (!schema || schema.type !== 'object' || !schema.properties) return [];

  const requiredSet = new Set<string>(Array.isArray(schema.required) ? schema.required : []);

  return Object.entries(schema.properties).map(([name, prop]) =>
    propertyToFieldMeta(name, prop as any, requiredSet.has(name)),
  );
}

/**
 * Convert a single JSON Schema property into a `FieldMeta`.
 */
function propertyToFieldMeta(name: string, prop: any, required: boolean): FieldMeta {
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
    const itemMeta = prop.items ? propertyToFieldMeta('item', prop.items, true) : undefined;
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
