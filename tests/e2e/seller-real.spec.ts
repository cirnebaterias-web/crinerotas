import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('seller keeps the cached route offline and receives the manager revision after reconnecting', async ({ page, context, request }, testInfo) => {
  const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
    actors: {
      seller_a: { email: string; password: string };
      manager_a: { accessToken: string };
    };
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('login-mobile.png'), fullPage: true });
  await page.getByLabel('E-mail', { exact: true }).fill(manifest.actors.seller_a.email);
  await page.getByLabel('Senha', { exact: true }).fill(manifest.actors.seller_a.password);
  await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
  await expect(page).toHaveURL(/\/route$/);
  await expect(page.locator('.seller-stop-card')).toHaveCount(2);
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const card = page.locator('.seller-stop-card').first();
  const destination = new URL((await card.getByRole('link', { name: /Navegar/ }).getAttribute('href'))!);
  expect(destination.origin).toBe('https://www.google.com');
  expect(destination.searchParams.get('api')).toBe('1');
  expect(destination.searchParams.get('destination')).toBeTruthy();
  await expect(card.getByRole('button', { name: /Copiar endereço/ })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('route-real-mobile.png'), fullPage: true });
  const first = await page.locator('.seller-stop-card h3').first().innerText();
  await page.getByRole('button', { name: 'Reordenar' }).click();
  await page.getByRole('button', { name: `Descer ${first}`, exact: true }).click();
  await page.getByRole('button', { name: 'Salvar ordem' }).click();
  await expect(page.getByText('Ordem salva e confirmada no servidor.')).toBeVisible();
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await page.reload();
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const current = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me/routes/today', { cache: 'no-store' });
    return response.json() as Promise<{
      route: {
        routeId: string;
        routeVersionId: string;
        versionNumber: number;
        executionVersion: number;
        stops: Array<{ client: { id: string; name: string } }>;
      };
    }>;
  });
  const candidateClients = [
    { id: '10000000-0000-4000-8000-000000000001', name: 'Cliente Sintético 01' },
    { id: '10000000-0000-4000-8000-000000000002', name: 'Cliente Sintético 02' },
    { id: '10000000-0000-4000-8000-000000000003', name: 'Cliente Sintético 03' },
  ];
  const currentClientIds = new Set(current.route.stops.map(({ client }) => client.id));
  const addedClient = candidateClients.find(({ id }) => !currentClientIds.has(id));
  const retainedClient = current.route.stops[0]?.client;
  if (!addedClient || !retainedClient) throw new Error('Synthetic composition fixture is incomplete.');
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await expect(page.getByText('última rota salva neste aparelho', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navegar', exact: true }).first()).toBeDisabled();

  const managerHeaders = {
    Authorization: `Bearer ${manifest.actors.manager_a.accessToken}`,
    'Content-Type': 'application/json',
  };
  const reason = 'Redistribuicao sintetica durante operacao offline';
  const changed = await request.patch(`/api/v1/routes/${current.route.routeId}`, {
    headers: { ...managerHeaders, 'Idempotency-Key': crypto.randomUUID() },
    data: {
      schemaVersion: 1,
      expectedVersion: current.route.executionVersion,
      reason,
      stops: [
        { clientId: retainedClient.id, plannedOrder: 1, priority: 1 },
        { clientId: addedClient.id, plannedOrder: 2, priority: 0 },
      ],
    },
  });
  expect(changed.status()).toBe(200);
  const changedBody = await changed.json() as { expectedVersion: number; versionNumber: number };
  expect(changedBody.versionNumber).toBe(current.route.versionNumber + 1);
  const published = await request.post(`/api/v1/routes/${current.route.routeId}/publish`, {
    headers: managerHeaders,
    data: { schemaVersion: 1, expectedVersion: changedBody.expectedVersion },
  });
  expect(published.status()).toBe(200);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.seller-stop-card h3').last()).toHaveText(first);
  await expect(page.getByText(addedClient.name, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'Docs/qa/evidence/2.6/route-before-reconnect.png', fullPage: true });
  await context.setOffline(false);
  await page.goto('/route');
  await expect(page.getByText(addedClient.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Rota atualizada pelo Gestor:', { exact: false })).toContainText(reason);
  await page.screenshot({ path: 'Docs/qa/evidence/2.6/route-after-reconnect.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('route-real-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/route');
  await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
});
