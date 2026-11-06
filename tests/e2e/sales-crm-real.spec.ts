import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { mePath, meResponseSchema } from '@cirne/contracts';
import { run, supabaseBinary } from '../../scripts/process';

type Actors = { actors: Record<string, { email: string; password: string }> };
const actorFor = async (key: string) => (JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as Actors).actors[key]!;
const clientId = '10000000-0000-4000-8000-000000000001';
async function login(page: Page, key: string) {
  const actor = await actorFor(key);
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(actor.email);
  await page.getByLabel('Senha', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test('CRM real BFF separates denial from a source with no published generation', async ({ page, request }) => {
  const path = `/api/v1/clients/${clientId}/sales`;
  expect((await request.get(path)).status()).toBe(401);
  await login(page, 'manager_a');
  const response = await page.request.get(path);
  expect(response.status()).toBe(503);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.json()).toMatchObject({ error: { code: 'DEPENDENCY_UNAVAILABLE',
    details: { reason: 'no_published_generation' } } });
  const unknown = await page.request.get('/api/v1/clients/41499999-0000-4000-8000-000000000001/sales');
  expect(unknown.status()).toBe(404);
  const identity = meResponseSchema.parse(await (await page.request.get(mePath)).json());
  const signals = await page.request.get(`/api/v1/management/sales-signals?${new URLSearchParams({
    sellerId: identity.scopeIds[0]!, serviceDate: '2026-11-03', clientIds: clientId,
  })}`);
  expect(signals.status()).toBe(503);
  expect(await signals.json()).toMatchObject({ error: { details: { reason: 'no_published_generation' } } });
});

test('seller reads its scoped CRM but cannot use management batches or bypass missing client scope', async ({ page }) => {
  await login(page, 'seller_a');
  expect((await page.request.get(`/api/v1/clients/${clientId}/sales`)).status()).toBe(503);
  expect((await page.request.get('/api/v1/clients/41499999-0000-4000-8000-000000000001/sales')).status()).toBe(404);
  expect((await page.request.get('/api/v1/management/sales-signals')).status()).toBe(403);
  expect((await page.request.get(`/api/v1/clients/${clientId}/sales?historyPage=2`)).status()).toBe(422);
});

test('real CRM CLI exits unsuccessfully without printing secrets or fake zero history when source is unavailable', async ({ request, baseURL }) => {
  const status = await run(supabaseBinary, ['status', '-o', 'json']);
  if (!status.ok) throw new Error('Supabase local indisponível.');
  const local = JSON.parse(status.output) as Record<string, string>;
  const actor = await actorFor('seller_a');
  const session = await request.post(`${local.API_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: local.PUBLISHABLE_KEY! }, data: { email: actor.email, password: actor.password },
  });
  if (!session.ok()) throw new Error('Autenticação sintética indisponível.');
  const token = (await session.json() as { access_token: string }).access_token;
  const result = await new Promise<{ code: string | number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'apps/cli/src/sales-crm-cli.ts',
      '--url', baseURL!, '--client', clientId, '--json'], { windowsHide: true, timeout: 30_000,
      env: { ...process.env, FORCE_COLOR: undefined, CIRNE_ACCESS_TOKEN: token } },
    (error, stdout, stderr) => resolve({ code: error?.code ?? null, stdout, stderr }));
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toMatchObject({ schemaVersion: 1, status: 'error' });
  for (const secret of [token, actor.email, actor.password]) expect(result.stderr).not.toContain(secret);
});
