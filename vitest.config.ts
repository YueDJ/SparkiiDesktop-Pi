import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    projects: [
      { test: { include: ['packages/**/test/**/*.test.ts'], pool: 'forks' } },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          include: ['apps/**/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          pool: 'forks',
        },
      },
    ],
  },
});
