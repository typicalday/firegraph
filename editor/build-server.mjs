import { build } from 'esbuild';

await build({
  entryPoints: ['editor/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/editor/server/index.mjs',
  external: ['firebase-admin', 'zod', 'jiti'],
  // jiti must be external because it dynamically loads babel transforms at runtime
  // via relative paths that break when bundled. Consumers need jiti installed.
  target: 'node18',
  absWorkingDir: new URL('..', import.meta.url).pathname,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

console.log('  Editor server built → dist/editor/server/index.mjs');
