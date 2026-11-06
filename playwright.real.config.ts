import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Real synthetic credentials must not be retained in browser traces.
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: ['**/seller-real.spec.ts', '**/scrap-agenda-real.spec.ts', '**/scrap-collection-real.spec.ts', '**/route-planning-real.spec.ts', '**/client-template-real.spec.ts', '**/client-sheet-sync-real.spec.ts', '**/sales-sync-real.spec.ts', '**/sales-crm-real.spec.ts', '**/scrap-ledger-real.spec.ts'],
  use: { ...base.use, trace: 'off' },
});
