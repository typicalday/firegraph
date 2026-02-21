import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
