import { expect } from '@playwright/test';
import { routeTodayResponseSchema, routeCompositionDraftSchema } from '@cirne/contracts';
import { test } from './real-route-fixture';

test('removed client keeps its original offline visit after real republication and synchronization', async ({ page, context, request, realRoute }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(realRoute.seller.email);
  await page.getByLabel('Senha', { exact: true }).fill(realRoute.seller.password);
  await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const response = await request.get('/api/v1/me/routes/today', {
    headers: { Authorization: `Bearer ${realRoute.seller.accessToken}` },
  });
  expect(response.status()).toBe(200);
  const current = routeTodayResponseSchema.parse(await response.json());
  if (current.availability !== 'available') throw new Error('Published synthetic route is required.');
  const originalStop = current.route.stops[0]!;
  const retainedStop = current.route.stops[1]!;
  const addedClient = realRoute.clients[2]!;

  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Iniciar visita' }).first().click();
  await expect(page.getByText('Salva no aparelho', { exact: true })).toBeVisible();
  const visitUrl = page.url();
  const offlineId = new URL(visitUrl).pathname.split('/').at(-1);
  const headers = { Authorization: `Bearer ${realRoute.manager.accessToken}` };
  const changed = await request.patch(`/api/v1/routes/${current.route.routeId}`, {
    headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
    data: { schemaVersion: 1, expectedVersion: current.route.executionVersion,
      reason: 'Retirada sintetica enquanto visita aguarda sincronizacao',
      stops: [
        { clientId: retainedStop.client.id, plannedOrder: 1, priority: 0 },
        { clientId: addedClient.id, plannedOrder: 2, priority: 0 },
      ] },
  });
  expect(changed.status()).toBe(200);
  const draft = routeCompositionDraftSchema.parse(await changed.json());
  const published = await request.post(`/api/v1/routes/${current.route.routeId}/publish`, {
    headers, data: { schemaVersion: 1, expectedVersion: draft.expectedVersion },
  });
  expect(published.status()).toBe(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Salva no aparelho', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Retornar à rota' }).click();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const savedVisits = page.getByRole('region', { name: 'Visitas salvas de outras versões' });
  await expect(savedVisits.getByRole('heading', { name: originalStop.client.name, exact: true })).toBeVisible();
  await expect(savedVisits.getByRole('button', { name: 'Iniciar visita' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Iniciar visita' })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('historical-visit-real-mobile.png'), fullPage: true });
  await savedVisits.getByRole('link', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await savedVisits.getByRole('link', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<Array<{ offlineId: string; routeVersionStopId: string; canonicalVisitId?: string }>>((resolve, reject) => {
        const reading = database.transaction('visitDrafts').objectStore('visitDrafts').getAll();
        reading.onsuccess = () => resolve(reading.result);
        reading.onerror = () => reject(reading.error);
      });
    } finally { database.close(); }
  });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ offlineId, routeVersionStopId: originalStop.routeVersionStopId,
    canonicalVisitId: expect.any(String) });
});

test('seller keeps the cached route offline and receives the manager revision after reconnecting', async ({ page, context, request, realRoute }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/login');
  await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('login-mobile.png'), fullPage: true });
  await page.getByLabel('E-mail', { exact: true }).fill(realRoute.seller.email);
  await page.getByLabel('Senha', { exact: true }).fill(realRoute.seller.password);
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
  const candidateClients = realRoute.clients;
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
    Authorization: `Bearer ${realRoute.manager.accessToken}`,
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
  await page.screenshot({ path: testInfo.outputPath('route-before-reconnect.png'), fullPage: true });
  await context.setOffline(false);
  await page.goto('/route');
  await expect(page.getByText(addedClient.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Rota atualizada pelo Gestor:', { exact: false })).toContainText(reason);
  await page.screenshot({ path: testInfo.outputPath('route-after-reconnect.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('route-real-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/route');
  await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
});

test('seller starts offline, reloads the pending visit and confirms it after reconnecting', async ({ page, context, realRoute }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(realRoute.seller.email);
  await page.getByLabel('Senha', { exact: true }).fill(realRoute.seller.password);
  await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Iniciar visita' }).first().click();
  await expect(page.getByText('Salva no aparelho', { exact: true })).toBeVisible();
  const visitUrl = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Salva no aparelho', { exact: true })).toBeVisible();
  await expect(page.getByText('Sincronizada', { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await expect(page).toHaveURL(visitUrl);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
});

test('seller saves real stock and reopens the canonical visit offline without duplication', async ({ page, context, realRoute }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(realRoute.seller.email);
  await page.getByLabel('Senha', { exact: true }).fill(realRoute.seller.password);
  await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
  await expect(page).toHaveURL(/\/route$/);
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const start = page.getByRole('button', { name: 'Iniciar visita' }).first();
  await expect(start).toBeVisible();
  await start.click();
  await expect(page).toHaveURL(/\/visit\/[0-9a-f-]+\?step=start$/i);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  const originalOfflineId = new URL(page.url()).pathname.split('/').at(-1);
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('9');
  await page.getByLabel('Observação (opcional)').fill('Estoque sintético real');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  const visitUrl = page.url();

  const saved = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const drafts = await new Promise<Array<{
      offlineId: string;
      canonicalVisitId?: string;
      stock?: { heliarQuantity: number; mouraQuantity: number; persistenceState: string };
    }>>((resolve, reject) => {
      const request = database.transaction('visitDrafts').objectStore('visitDrafts').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return drafts;
  });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    offlineId: originalOfflineId,
    canonicalVisitId: expect.any(String),
    stock: { heliarQuantity: 0, mouraQuantity: 9, persistenceState: 'synced' },
  });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continuar visita' }).first().click();
  await expect(page).toHaveURL(visitUrl);
  const count = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const value = await new Promise<number>((resolve, reject) => {
      const request = database.transaction('visitDrafts').objectStore('visitDrafts').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  });
  expect(count).toBe(1);
});
