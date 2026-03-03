import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readEditorPort } from '../../../src/query-client/config.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('readEditorPort', () => {
  it('returns default port 3884 when no config files exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(3884);
  });

  it('extracts port from firegraph.config.ts', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        return `export default defineConfig({
  entities: './entities',
  editor: {
    port: 4000,
  },
});`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(4000);
  });

  it('extracts port from firegraph.config.js when ts not found', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        throw new Error('ENOENT');
      }
      if (String(path).endsWith('firegraph.config.js')) {
        return `module.exports = { editor: { port: 5555 } };`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(5555);
  });

  it('extracts port from firegraph.config.mjs', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.mjs')) {
        return `export default { editor: { port: 9999 } };`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(9999);
  });

  it('returns default when config has no editor block', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        return `export default defineConfig({ entities: './entities' });`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(3884);
  });

  it('returns default when editor block has no port', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        return `export default defineConfig({ editor: { readonly: true } });`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(3884);
  });

  it('uses process.cwd() when no dir provided', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    readEditorPort();
    // Should have tried all 3 config files from process.cwd()
    expect(mockReadFileSync).toHaveBeenCalledTimes(3);
    const cwd = process.cwd();
    expect(mockReadFileSync.mock.calls[0][0]).toBe(`${cwd}/firegraph.config.ts`);
    expect(mockReadFileSync.mock.calls[1][0]).toBe(`${cwd}/firegraph.config.js`);
    expect(mockReadFileSync.mock.calls[2][0]).toBe(`${cwd}/firegraph.config.mjs`);
  });

  it('stops at first config file with a port match', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        return `export default { editor: { port: 1111 } };`;
      }
      // Should never reach .js or .mjs
      if (String(path).endsWith('firegraph.config.js')) {
        return `module.exports = { editor: { port: 2222 } };`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(1111);
    // Only the .ts file should have been read
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it('handles editor block with extra whitespace', () => {
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).endsWith('firegraph.config.ts')) {
        return `export default {
  editor :  {
    port :  7777 ,
    readonly: false
  }
};`;
      }
      throw new Error('ENOENT');
    });
    expect(readEditorPort('/test')).toBe(7777);
  });
});
