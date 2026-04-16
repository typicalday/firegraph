import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/codegen/index.ts',
    'src/react.ts',
    'src/svelte.ts',
    'src/query-client/index.ts',
    'src/d1.ts',
    'src/do-sqlite.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: [
    '@google-cloud/firestore',
    'json-schema-to-typescript',
    'react',
    'react-dom',
    'svelte',
    'ses',
  ],
  esbuildOptions(options) {
    options.logOverride = {
      'empty-import-meta': 'silent',
    };
  },
});
