import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createRegistry } from '../../src/registry.js';
import { RegistryViolationError, ValidationError } from '../../src/errors.js';

const tourSchema = z.object({ name: z.string() });
const edgeSchema = z.object({ order: z.number() });

describe('createRegistry', () => {
  it('lookup returns the entry for a registered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour', dataSchema: tourSchema },
    ]);
    const entry = registry.lookup('tour', 'is', 'tour');
    expect(entry).toBeDefined();
    expect(entry!.aType).toBe('tour');
  });

  it('lookup returns undefined for an unregistered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour' },
    ]);
    const entry = registry.lookup('user', 'is', 'user');
    expect(entry).toBeUndefined();
  });

  it('validate passes for a registered triple with valid data', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour', dataSchema: tourSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'Dolomites' })).not.toThrow();
  });

  it('validate throws RegistryViolationError for unregistered triple', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour' },
    ]);
    expect(() => registry.validate('booking', 'is', 'booking', {})).toThrow(
      RegistryViolationError,
    );
  });

  it('validate throws ValidationError for invalid data', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour', dataSchema: tourSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 123 })).toThrow(
      ValidationError,
    );
  });

  it('validate passes when no dataSchema is defined', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour' },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { anything: 'goes' })).not.toThrow();
  });

  it('supports multiple triples', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour', dataSchema: tourSchema },
      { aType: 'tour', abType: 'hasDeparture', bType: 'departure', dataSchema: edgeSchema },
    ]);
    expect(() => registry.validate('tour', 'is', 'tour', { name: 'X' })).not.toThrow();
    expect(() => registry.validate('tour', 'hasDeparture', 'departure', { order: 0 })).not.toThrow();
  });

  it('ValidationError includes Zod details', () => {
    const registry = createRegistry([
      { aType: 'tour', abType: 'is', bType: 'tour', dataSchema: tourSchema },
    ]);
    try {
      registry.validate('tour', 'is', 'tour', { name: 123 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toBeDefined();
    }
  });
});
