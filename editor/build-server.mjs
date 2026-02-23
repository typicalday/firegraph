import { build } from 'esbuild';

await build({
  entryPoints: ['editor/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/editor/server/index.mjs',
  external: ['firebase-admin', 'jiti', 'esbuild'],
  // jiti and esbuild must be external because they use native binaries / dynamic
  // requires that break when bundled. Consumers need them installed.
  target: 'node18',
  absWorkingDir: new URL('..', import.meta.url).pathname,
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

console.log('  Editor server built → dist/editor/server/index.mjs');
