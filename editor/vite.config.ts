import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3883,
    proxy: {
      '/api': 'http://localhost:3884',
    },
  },
  build: {
    outDir: '../dist/editor/client',
    emptyOutDir: true,
  },
});
