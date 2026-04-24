import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` is a virtual builtin only resolvable by workerd.
      // Node tests would crash at import time without an alias. The shim
      // exposes a minimal `DurableObject` base — see `tests/__shims__/`.
      'cloudflare:workers': fileURLToPath(
        new URL('./tests/__shims__/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/pipeline/**',
      'tests/integration-pipeline/**',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
