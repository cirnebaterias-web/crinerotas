import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { projects: [
  { test: { name: 'unit', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts'] } },
  { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 30000, hookTimeout: 60000 } },
] } });
