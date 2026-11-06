import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, key: 'manager_a' | 'seller_a') {
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: Record<string, { email: string; password: string }>;
  };
  const actor = manifest.actors[key]!;
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(actor.email);
  await page.getByLabel('Senha', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
test('real manager sees disabled sync, unauthenticated and cross-origin requests fail closed', async ({ page, request }) => {
  expect((await request.get('/api/v1/client-sync')).status()).toBe(401);
  await login(page, 'manager_a');
  await page.goto('/management/clients');
  await expect(page.getByRole('button', { name: 'Atualizar agora', exact: true })).toBeDisabled();
  const status = await page.request.get('/api/v1/client-sync');
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ configured: false, reason: 'disabled' });
  const command = { trigger: 'manual', idempotencyKey: '31300000-0000-4000-8000-000000000099' };
  const denied = await page.request.post('/api/v1/client-sync', {
    headers: { origin: 'https://attacker.example.invalid', 'x-csrf-token': 'cirne-route-v1' }, data: command,
  });
  expect(denied.status()).toBe(403);
  const unavailable = await page.evaluate(async (body) => {
    const response = await fetch('/api/v1/client-sync', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, command);
  expect(unavailable.status).toBe(503);
  expect(unavailable.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
  await page.screenshot({ path: '.local/client-sheet-sync-inactive.png', fullPage: true });
});
test('real seller cannot inspect or trigger sync by bypassing the UI', async ({ page }) => {
  await login(page, 'seller_a');
  expect((await page.request.get('/api/v1/client-sync')).status()).toBe(403);
  const denied = await page.evaluate(async () => (await fetch('/api/v1/client-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' },
    body: JSON.stringify({ trigger: 'manual', idempotencyKey: crypto.randomUUID() }),
  })).status);
  expect(denied).toBe(403);
});
