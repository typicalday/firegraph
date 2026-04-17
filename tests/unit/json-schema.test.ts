import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors.js';
import { compileSchema, jsonSchemaToFieldMeta } from '../../src/json-schema.js';

describe('compileSchema', () => {
  it('validates valid data without throwing', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    expect(() => validate({ name: 'hello' })).not.toThrow();
  });

  it('throws ValidationError for invalid data', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    expect(() => validate({ name: 123 })).toThrow(ValidationError);
  });

  it('throws ValidationError for missing required fields', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    expect(() => validate({})).toThrow(ValidationError);
  });

  it('rejects extra properties when additionalProperties is false', () => {
    const validate = compileSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    expect(() => validate({ name: 'ok', extra: true })).toThrow(ValidationError);
  });

  it('includes label in error message', () => {
    const validate = compileSchema(
      { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
      '(tour) -[is]-> (tour)',
    );
    try {
      validate({});
      expect.fail('Should throw');
    } catch (err) {
      expect((err as ValidationError).message).toContain('(tour) -[is]-> (tour)');
    }
  });

  it('error details contain ajv error objects', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'number' } },
    });
    try {
      validate({ x: 'not a number' });
      expect.fail('Should throw');
    } catch (err) {
      expect((err as ValidationError).details).toBeDefined();
      expect(Array.isArray((err as ValidationError).details)).toBe(true);
    }
  });
});

describe('jsonSchemaToFieldMeta', () => {
  it('returns empty array for non-object schemas', () => {
    expect(jsonSchemaToFieldMeta({ type: 'string' })).toEqual([]);
    expect(jsonSchemaToFieldMeta({})).toEqual([]);
    expect(jsonSchemaToFieldMeta(null)).toEqual([]);
  });

  it('extracts string fields', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Z]' },
      },
    });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      name: 'name',
      type: 'string',
      required: true,
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Z]',
      description: undefined,
    });
  });

  it('extracts number fields', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 0, maximum: 100, description: 'Total count' },
      },
    });
    expect(fields[0]).toMatchObject({
      name: 'count',
      type: 'number',
      required: false,
      min: 0,
      max: 100,
      description: 'Total count',
    });
  });

  it('extracts integer fields with isInt', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      required: ['order'],
      properties: {
        order: { type: 'integer', minimum: 0 },
      },
    });
    expect(fields[0]).toMatchObject({
      name: 'order',
      type: 'number',
      required: true,
      isInt: true,
      min: 0,
    });
  });

  it('extracts boolean fields', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: { active: { type: 'boolean' } },
    });
    expect(fields[0]).toMatchObject({ name: 'active', type: 'boolean', required: false });
  });

  it('extracts enum fields', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['active', 'inactive', 'pending'] },
      },
    });
    expect(fields[0]).toMatchObject({
      name: 'status',
      type: 'enum',
      required: true,
      enumValues: ['active', 'inactive', 'pending'],
    });
  });

  it('extracts enum fields without type', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        status: { enum: ['a', 'b'] },
      },
    });
    expect(fields[0].type).toBe('enum');
    expect(fields[0].enumValues).toEqual(['a', 'b']);
  });

  it('extracts array fields with item metadata', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(fields[0]).toMatchObject({
      name: 'tags',
      type: 'array',
      required: false,
    });
    expect(fields[0].itemMeta).toMatchObject({
      name: 'item',
      type: 'string',
      required: true,
    });
  });

  it('extracts nested object fields', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          required: ['city'],
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
        },
      },
    });
    expect(fields[0].type).toBe('object');
    expect(fields[0].fields).toHaveLength(2);
    expect(fields[0].fields![0]).toMatchObject({ name: 'city', type: 'string', required: true });
    expect(fields[0].fields![1]).toMatchObject({ name: 'zip', type: 'string', required: false });
  });

  it('handles oneOf nullable pattern', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        note: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    });
    expect(fields[0]).toMatchObject({ name: 'note', type: 'string', required: false });
  });

  it('marks unknown types correctly', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      properties: {
        weird: { description: 'something' },
      },
    });
    expect(fields[0].type).toBe('unknown');
  });

  it('optional fields not in required array', () => {
    const fields = jsonSchemaToFieldMeta({
      type: 'object',
      required: ['a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    });
    expect(fields[0].required).toBe(true);
    expect(fields[1].required).toBe(false);
  });
});
