import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = import.meta.dirname;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Router tests bind real upstream sockets and each build their own
    // in-memory database; a single fork keeps port allocation and SQLite
    // handles from interleaving across files.
    pool: 'forks',
    forks: { singleFork: true },
  },
  resolve: {
    alias: {
      '@router/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@router/config': resolve(root, 'packages/config/src/index.ts'),
      '@router/router-core': resolve(root, 'packages/router-core/src/index.ts'),
      '@router/providers': resolve(root, 'packages/providers/src/index.ts'),
      '@router/api': resolve(root, 'apps/api/src/index.ts'),
    },
  },
});
