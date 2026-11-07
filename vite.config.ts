import { defineConfig } from 'vitest/config';

// The client lives in /client. In development Vite serves it on :5173 and forwards the
// WebSocket endpoint to the game server (npm run dev:server, default :8787).
// In production the game server serves the built files from dist/client itself.
const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  root: 'client',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      '/healthz': { target: `http://127.0.0.1:${serverPort}` },
    },
  },
  test: {
    root: '.',
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
  },
});
