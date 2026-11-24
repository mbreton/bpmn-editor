import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', ws: true }, '/healthz': 'http://localhost:3000', '/mcp': 'http://localhost:3000', '/oauth': 'http://localhost:3000', '/.well-known': 'http://localhost:3000' } }
});
