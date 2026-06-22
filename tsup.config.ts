import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/backend.ts',
    'src/codegen/index.ts',
    'src/react.ts',
    'src/svelte.ts',
    'src/query-client/index.ts',
    'src/cloudflare/index.ts',
    'src/firestore-standard/index.ts',
    'src/firestore-enterprise/index.ts',
    'src/sqlite/index.ts',
    'src/sqlite/local.ts',
    'src/sqlite/node-sqlite.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // Preserve the `node:` scheme on Node built-in imports in the emitted output.
  // tsup defaults this to `true` which strips `node:` from all built-in specifiers.
  // Disabling it lets esbuild (platform: node) handle built-ins natively, which
  // preserves `node:sqlite` so that the `external` entry below takes effect and
  // the emitted dist retains `"node:sqlite"` rather than the non-existent `"sqlite"`.
  removeNodeProtocol: false,
  external: [
    '@google-cloud/firestore',
    'json-schema-to-typescript',
    'react',
    'react-dom',
    'svelte',
    'ses',
    // Optional peer — only `firegraph/sqlite-local` imports it (dynamically).
    // Mark external so the native module is never bundled.
    'better-sqlite3',
    // Node 22.5+ built-in — only resolvable at runtime, not at build time.
    // Without this entry esbuild (via the node18 target) strips the `node:` scheme
    // and emits bare `"sqlite"` which does not exist as an npm package.
    'node:sqlite',
    // Virtual workerd builtin — only resolvable inside Cloudflare Workers.
    // Mark external so esbuild/tsup leaves the import alone for the runtime
    // to handle. Without this, bundling fails: there's no real module to
    // resolve at build time.
    'cloudflare:workers',
  ],
  esbuildOptions(options) {
    options.logOverride = {
      'empty-import-meta': 'silent',
    };
  },
});
