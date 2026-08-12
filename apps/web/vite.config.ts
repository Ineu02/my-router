import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * The router API (and mock upstream behind it) is expected on 20128 — the
 * ROUTER_PORT from the repo's .env. Everything under /api and /v1 is proxied
 * there so the browser only ever talks to this dev origin: same-origin means
 * the admin session cookie and the EventSource live feed work with no CORS
 * dance. Port 3000 matches the CORS_ORIGINS allowlist too, so a direct
 * (non-proxied) call would also be accepted.
 */
const ROUTER_ORIGIN = 'http://127.0.0.1:20128';

export default defineConfig({
  server: {
    port: 3000,
    strictPort: false,
    proxy: {
      '/api': {
        target: ROUTER_ORIGIN,
        changeOrigin: true,
        // SSE: never buffer the /api/admin/events stream.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.url?.startsWith('/api/admin/events')) {
              proxyReq.setHeader('accept', 'text/event-stream');
            }
          });
        },
      },
      '/v1': { target: ROUTER_ORIGIN, changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@router/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
