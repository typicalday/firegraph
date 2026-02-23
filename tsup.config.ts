import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/codegen/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  external: ['firebase-admin', 'json-schema-to-typescript'],
});
