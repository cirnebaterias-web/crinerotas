import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { projects: [
  { test: { name: 'unit', include: ['packages/**/*.test.ts', 'apps/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'] } },
  { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false, testTimeout: 60000, hookTimeout: 90000 } },
] } });
