import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { salesSyncStatusSchema } from '@cirne/contracts';
import { run, supabaseBinary } from '../../scripts/process';

type Actors = { actors: Record<string, { email: string; password: string }> };
const actors = async () => JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as Actors;
async function login(page: Page, key: string) {
  const actor = (await actors()).actors[key]!;
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(actor.email);
  await page.getByLabel('Senha', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('sales HTTP rejects anonymous/seller access and browser execution, with private disabled status', async ({ page, request }) => {
  expect((await request.get('/api/v1/sales-sync')).status()).toBe(401);
  await login(page, 'manager_a');
  const response = await page.request.get('/api/v1/sales-sync');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(salesSyncStatusSchema.parse(await response.json())).toMatchObject({ configured: false,
    reason: 'disabled', scheduleEnabled: false, latestRun: null, lastPublishedRun: null });
  const results = await page.evaluate(async () => {
    const run = '41300000-0000-4000-8000-000000000099';
    return Promise.all(['stage', 'publish', 'fail'].map(async (action) => {
      const result = await fetch(`/api/v1/sales-sync/runs/${run}/${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' }, body: '{}' });
      return { status: result.status, error: (await result.json()).error.code };
    }));
  });
  expect(results).toEqual(Array.from({ length: 3 }, () => ({ status: 403, error: 'FORBIDDEN' })));
  const crossOrigin = await page.request.post('/api/v1/sales-sync/runs', {
    headers: { origin: 'https://attacker.example.invalid', 'x-csrf-token': 'cirne-route-v1' },
    data: { trigger: 'manual', idempotencyKey: crypto.randomUUID() },
  });
  expect(crossOrigin.status()).toBe(403);
  const disabled = await page.evaluate(async () => {
    const result = await fetch('/api/v1/sales-sync/runs', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
      body: JSON.stringify({ trigger: 'manual', idempotencyKey: crypto.randomUUID() }) });
    return { status: result.status, error: (await result.json()).error.code };
  });
  expect(disabled).toEqual({ status: 503, error: 'DEPENDENCY_UNAVAILABLE' });
});

test('seller cannot inspect or trigger sales imports through the real BFF', async ({ page }) => {
  await login(page, 'seller_a');
  expect((await page.request.get('/api/v1/sales-sync')).status()).toBe(403);
  const status = await page.evaluate(async () => (await fetch('/api/v1/sales-sync/runs', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
    body: JSON.stringify({ trigger: 'manual', idempotencyKey: crypto.randomUUID() }) })).status);
  expect(status).toBe(403);
});

test('real one-shot CLI logs in and emits safe disabled JSON without Google access', async ({ baseURL }) => {
  const result = await run(supabaseBinary, ['status', '-o', 'json']);
  if (!result.ok) throw new Error('Supabase local indisponível.');
  const local = JSON.parse(result.output) as Record<string, string>;
  const actor = (await actors()).actors.manager_a!;
  const output = await promisify(execFile)(process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/sales-sync-cli.ts', '--url', baseURL!, '--status', '--json'], {
      windowsHide: true, timeout: 30_000, env: { ...process.env, FORCE_COLOR: undefined,
        SUPABASE_PUBLIC_URL: local.API_URL, SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
        CIRNE_SALES_SYNC_EMAIL: actor.email, CIRNE_SALES_SYNC_PASSWORD: actor.password },
    });
  expect(salesSyncStatusSchema.parse(JSON.parse(output.stdout))).toMatchObject({ configured: false, reason: 'disabled' });
  expect(output.stderr).toBe('');
  expect(output.stdout).not.toContain(actor.email);
  expect(output.stdout).not.toContain(actor.password);
});
