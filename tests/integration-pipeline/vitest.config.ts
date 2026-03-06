import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration-pipeline/**/*.test.ts'],
  },
});
