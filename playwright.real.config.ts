import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Real synthetic credentials must not be retained in browser traces.
export default defineConfig({ ...base, testIgnore: [], testMatch: '**/seller-real.spec.ts', use: { ...base.use, trace: 'off' } });
