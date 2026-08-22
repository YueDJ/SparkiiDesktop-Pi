import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root,
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['apps/**', 'jsdom']],
    pool: 'forks',
  },
});
