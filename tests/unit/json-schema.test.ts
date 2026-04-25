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

  it('error details contain cfworker OutputUnit objects', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['x'],
      properties: { x: { type: 'number' } },
    });
    try {
      validate({ x: 'not a number' });
      expect.fail('Should throw');
    } catch (err) {
      const details = (err as ValidationError).details as Array<Record<string, unknown>>;
      expect(Array.isArray(details)).toBe(true);
      expect(details.length).toBeGreaterThan(0);
      // OutputUnit shape from @cfworker/json-schema
      expect(details[0]).toMatchObject({
        keyword: expect.any(String),
        keywordLocation: expect.any(String),
        instanceLocation: expect.any(String),
        error: expect.any(String),
      });
    }
  });

  it('collects all violations (shortCircuit disabled)', () => {
    // Two distinct violations: `name` wrong type, and `age` wrong type.
    // With shortCircuit=true (the cfworker default), only one would
    // surface — this test guards against accidentally re-enabling it.
    const validate = compileSchema({
      type: 'object',
      required: ['name', 'age'],
      properties: { name: { type: 'string' }, age: { type: 'number' } },
    });
    try {
      validate({ name: 123, age: 'old' });
      expect.fail('Should throw');
    } catch (err) {
      const e = err as ValidationError;
      const details = e.details as Array<Record<string, unknown>>;
      expect(details.length).toBeGreaterThanOrEqual(2);
      expect(e.message).toContain('/name');
      expect(e.message).toContain('/age');
    }
  });

  it('renders root-level errors with `/` rather than `#`', () => {
    // `additionalProperties: false` rejects at the root; cfworker
    // reports `instanceLocation: '#'`, which the formatter must strip
    // so the message reads `/: ...` (Ajv-shaped) instead of `#: ...`.
    const validate = compileSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    });
    try {
      validate({ name: 'ok', extra: true });
      expect.fail('Should throw');
    } catch (err) {
      const msg = (err as ValidationError).message;
      expect(msg).not.toContain('#:');
      expect(msg).not.toContain('#/');
      expect(msg).toMatch(/(^|: |; )\//);
    }
  });

  it('error message includes the JSON Schema keyword tag', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    try {
      validate({});
      expect.fail('Should throw');
    } catch (err) {
      // `[required]` (or similar bracketed keyword) makes the message
      // actionable when cfworker's `error` text is terse.
      expect((err as ValidationError).message).toMatch(/\[[a-zA-Z]+\]/);
    }
  });

  it('enforces email format', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', format: 'email' } },
    });
    expect(() => validate({ email: 'alice@example.com' })).not.toThrow();
    expect(() => validate({ email: 'not-an-email' })).toThrow(ValidationError);
  });

  it('enforces uuid format', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } },
    });
    expect(() => validate({ id: '550e8400-e29b-41d4-a716-446655440000' })).not.toThrow();
    expect(() => validate({ id: 'not-a-uuid' })).toThrow(ValidationError);
  });

  it('caps the rendered message at MAX_RENDERED_ERRORS but preserves all in details', () => {
    // Build a schema with 30 required string properties, then validate
    // an empty object — cfworker emits one error per missing property.
    // The rendered message should cap at 20 with an "(+N more)" tail;
    // `details` should contain every error.
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (let i = 0; i < 30; i++) {
      properties[`f${i}`] = { type: 'string' };
      required.push(`f${i}`);
    }
    const validate = compileSchema({ type: 'object', required, properties });
    try {
      validate({});
      expect.fail('Should throw');
    } catch (err) {
      const e = err as ValidationError;
      const details = e.details as unknown[];
      expect(details.length).toBeGreaterThanOrEqual(30);
      expect(e.message).toContain('(+');
      expect(e.message).toContain('more)');
      // Sanity: not every field name should appear in the truncated message.
      expect(e.message).not.toContain('f29');
    }
  });

  it('enforces date-time format', () => {
    const validate = compileSchema({
      type: 'object',
      required: ['ts'],
      properties: { ts: { type: 'string', format: 'date-time' } },
    });
    expect(() => validate({ ts: '2026-04-24T10:00:00Z' })).not.toThrow();
    expect(() => validate({ ts: 'yesterday' })).toThrow(ValidationError);
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
