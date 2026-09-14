import { defineConfig, devices } from '@playwright/test';

const port = 3200;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    baseURL,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start',
    url: `${baseURL}/api/v1/health/live`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_BASE_URL: baseURL,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
