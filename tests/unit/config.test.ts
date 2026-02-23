import { describe, it, expect } from 'vitest';
import { resolveView } from '../../src/config.js';

describe('resolveView', () => {
  const available = ['card', 'detail', 'badge', 'row'];

  it('returns json when no config', () => {
    expect(resolveView(undefined, available)).toBe('json');
  });

  it('returns global default', () => {
    expect(resolveView({ default: 'card' }, available)).toBe('card');
  });

  it('returns json when default is not in available list', () => {
    expect(resolveView({ default: 'nonexistent' }, available)).toBe('json');
  });

  it('uses context-specific default when context is provided', () => {
    const config = { default: 'card', listing: 'row', detail: 'detail' };
    expect(resolveView(config, available, 'listing')).toBe('row');
    expect(resolveView(config, available, 'detail')).toBe('detail');
  });

  it('falls back to global default when context key is missing', () => {
    const config = { default: 'card', listing: 'row' };
    expect(resolveView(config, available, 'detail')).toBe('card');
  });

  it('falls back to json when context key is missing and no global default', () => {
    const config = { listing: 'row' };
    expect(resolveView(config, available, 'detail')).toBe('json');
  });

  it('ignores context view not in available list', () => {
    const config = { listing: 'nonexistent', default: 'card' };
    expect(resolveView(config, available, 'listing')).toBe('card');
  });

  it('context is ignored when undefined (backward compat)', () => {
    const config = { default: 'card', listing: 'row' };
    expect(resolveView(config, available)).toBe('card');
    expect(resolveView(config, available, undefined)).toBe('card');
  });

  it('inline context works', () => {
    const config = { default: 'card', inline: 'badge' };
    expect(resolveView(config, available, 'inline')).toBe('badge');
  });
});
