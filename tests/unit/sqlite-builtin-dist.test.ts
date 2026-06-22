/**
 * Dist-integrity test for `dist/sqlite/node-sqlite.{js,cjs}`.
 *
 * Asserts that the built artifacts preserve the `node:sqlite` specifier and do
 * NOT contain a bare `"sqlite"` module reference, which would cause
 * ERR_MODULE_NOT_FOUND at runtime because no npm package named `sqlite` exists.
 *
 * Root cause: esbuild's `node18` target strips the `node:` scheme from imports
 * it recognises as built-ins. `node:sqlite` is only available from Node 22.5,
 * so esbuild has no entry for it in its built-in module table for that target,
 * and without an `external` entry it rewrites the import to the bare specifier.
 *
 * This test is skip-guarded on `hasDist` so it silently skips in watch mode
 * for developers who have not built yet. In CI the `build` job always runs
 * `pnpm build` first and then invokes this test, so `hasDist` is always true.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url).pathname;
const esmDist = join(root, 'dist/sqlite/node-sqlite.js');
const cjsDist = join(root, 'dist/sqlite/node-sqlite.cjs');
const hasDist = existsSync(esmDist) && existsSync(cjsDist);

describe.skipIf(!hasDist)('dist/sqlite/node-sqlite — node:sqlite import integrity', () => {
  for (const [label, distPath] of [
    ['ESM', esmDist],
    ['CJS', cjsDist],
  ] as const) {
    it(`${label}: does not contain bare "sqlite" module reference`, () => {
      const text = readFileSync(distPath, 'utf8');
      expect(text).not.toMatch(/from ["']sqlite["']/);
      expect(text).not.toMatch(/require\(["']sqlite["']\)/);
    });

    it(`${label}: preserves node:sqlite specifier`, () => {
      const text = readFileSync(distPath, 'utf8');
      expect(text).toMatch(/node:sqlite/);
    });
  }
});
