import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Source regressions reuse dev; service-worker/offline-route tests use the production config.
export default defineConfig({ ...base, use: { ...base.use, baseURL: 'http://127.0.0.1:3000' }, testMatch: ['**/scrap-schedule.spec.ts', '**/scrap-corrections.spec.ts', '**/seller-experience.spec.ts'], grepInvert: /real route offline fallback/, webServer: {
  ...base.webServer as object, command: 'npm run dev --workspace @cirne/web -- --port 3000', url: 'http://127.0.0.1:3000/api/v1/health/live', reuseExistingServer: true,
} });
