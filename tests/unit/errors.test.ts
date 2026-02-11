import { describe, it, expect } from 'vitest';
import {
  FiregraphError,
  NodeNotFoundError,
  EdgeNotFoundError,
  ValidationError,
  RegistryViolationError,
  InvalidQueryError,
} from '../../src/errors.js';

describe('FiregraphError', () => {
  it('has correct name, code, and message', () => {
    const err = new FiregraphError('test message', 'TEST_CODE');
    expect(err.name).toBe('FiregraphError');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FiregraphError);
  });
});

describe('NodeNotFoundError', () => {
  it('has correct name, code, and includes uid in message', () => {
    const err = new NodeNotFoundError('abc123');
    expect(err.name).toBe('NodeNotFoundError');
    expect(err.code).toBe('NODE_NOT_FOUND');
    expect(err.message).toContain('abc123');
    expect(err).toBeInstanceOf(FiregraphError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('EdgeNotFoundError', () => {
  it('has correct name, code, and includes edge details in message', () => {
    const err = new EdgeNotFoundError('a1', 'hasDeparture', 'b2');
    expect(err.name).toBe('EdgeNotFoundError');
    expect(err.code).toBe('EDGE_NOT_FOUND');
    expect(err.message).toContain('a1');
    expect(err.message).toContain('hasDeparture');
    expect(err.message).toContain('b2');
    expect(err).toBeInstanceOf(FiregraphError);
  });
});

describe('ValidationError', () => {
  it('has correct name, code, and optional details', () => {
    const details = { field: 'name', issue: 'required' };
    const err = new ValidationError('Invalid data', details);
    expect(err.name).toBe('ValidationError');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid data');
    expect(err.details).toEqual(details);
    expect(err).toBeInstanceOf(FiregraphError);
  });

  it('works without details', () => {
    const err = new ValidationError('Bad input');
    expect(err.details).toBeUndefined();
  });
});

describe('RegistryViolationError', () => {
  it('has correct name, code, and includes triple in message', () => {
    const err = new RegistryViolationError('tour', 'hasDeparture', 'departure');
    expect(err.name).toBe('RegistryViolationError');
    expect(err.code).toBe('REGISTRY_VIOLATION');
    expect(err.message).toContain('tour');
    expect(err.message).toContain('hasDeparture');
    expect(err.message).toContain('departure');
    expect(err).toBeInstanceOf(FiregraphError);
  });
});

describe('InvalidQueryError', () => {
  it('has correct name, code, and message', () => {
    const err = new InvalidQueryError('No filter params provided');
    expect(err.name).toBe('InvalidQueryError');
    expect(err.code).toBe('INVALID_QUERY');
    expect(err.message).toBe('No filter params provided');
    expect(err).toBeInstanceOf(FiregraphError);
  });
});
