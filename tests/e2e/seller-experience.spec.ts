import { expect, test, type Page } from '@playwright/test';
import type { CanonicalRoute, MeResponse } from '@cirne/contracts';

const id = (number: number) => `11111111-1111-4111-8111-${String(number).padStart(12, '0')}`;
const identity: MeResponse = {
  id: id(1), displayName: 'Marina • Vendedora sintética', roles: ['seller'],
  capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self'], scopeIds: [id(1)], status: 'active',
};
const initialRoute: CanonicalRoute = {
  schemaVersion: 2, routeId: id(2), routeVersionId: id(3), versionNumber: 1,
  serviceDate: '2026-09-16', status: 'published', publishedAt: '2026-09-16T09:00:00Z', executionVersion: 1,
  seller: { id: identity.id, displayName: identity.displayName },
  stops: ['Autopeças Central', 'Oficina Boa Viagem', 'Baterias do Norte'].map((name, index) => ({
    routeVersionStopId: id(index + 10), plannedOrder: index + 1, executionOrder: index + 1,
    priority: index + 1, status: index === 1 ? 'completed' : 'pending', executionVersion: 1,
    client: { id: id(index + 20), name, address: `Rua de demonstração, ${index + 100} — Recife, PE`, externalReference: null, latitude: null, longitude: null, portfolioReference: null },
  })),
};

async function setup(page: Page, options: { empty?: boolean; fail?: boolean; conflict?: boolean; unauthorized?: boolean; networkSave?: boolean } = {}) {
  let route = structuredClone(initialRoute);
  const commands: unknown[] = [];
  let loggedOut = false;
  await page.route('**/api/v1/**', async (request) => {
    const url = new URL(request.request().url());
    if (url.pathname === '/api/v1/auth/session') {
      if (request.request().method() === 'DELETE') { loggedOut = true; await request.fulfill({ status: 204 }); }
      else await request.fulfill({ json: identity });
    } else if (url.pathname === '/api/v1/me') {
      await request.fulfill({ status: options.unauthorized || loggedOut ? 401 : 200, json: identity });
    } else if (url.pathname.endsWith('/execution-order')) {
      commands.push(request.request().postDataJSON());
      if (options.networkSave) { await request.abort('failed'); return; }
      if (options.conflict) { await request.fulfill({ status: 409, json: {} }); return; }
      const body = request.request().postDataJSON() as { pendingStopIds: string[] };
      let index = 0;
      const nextStops = route.stops.map((stop) => {
        if (stop.status !== 'pending') return stop;
        const nextId = body.pendingStopIds[index++];
        return { ...route.stops.find((item) => item.routeVersionStopId === nextId)!, executionOrder: stop.executionOrder };
      });
      route = { ...route, stops: nextStops, executionVersion: route.executionVersion + 1 };
      await request.fulfill({ json: { schemaVersion: 1, routeId: route.routeId, routeVersionId: route.routeVersionId, executionVersion: route.executionVersion, changed: true, pendingStopIds: body.pendingStopIds } });
    } else if (url.pathname.endsWith('/today')) {
      await request.fulfill({ status: options.fail ? 503 : 200, json: options.empty
        ? { schemaVersion: 2, availability: 'empty', serviceDate: '2026-09-16' }
        : { schemaVersion: 2, availability: 'available', route } });
    } else await request.continue();
  });
  return commands;
}

test.describe('seller visual MVP', () => {
  test.use({ serviceWorkers: 'block' });

  test('login labels, password visibility, generic failure and successful navigation', async ({ page }) => {
    await setup(page);
    await page.goto('/login');
    await page.getByLabel('E-mail', { exact: true }).fill('seller@example.test');
    await page.getByLabel('Senha', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'Mostrar' }).click();
    await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Ocultar' }).click();
    await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 401, json: {} }));
    await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Confira seu e-mail' })).toBeVisible();
    await page.unroute('**/api/v1/auth/session');
    await page.getByRole('button', { name: 'Entrar e ver minha rota' }).click();
    await expect(page).toHaveURL(/\/route$/);
    await expect(page.getByRole('heading', { name: 'Autopeças Central' })).toBeVisible();
    expect(await page.evaluate(() => Object.values(localStorage).join(' '))).not.toContain('synthetic-password');
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    test(`reorders, cancels and confirms canonical state at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const commands = await setup(page);
      await page.goto('/route');
      await expect(page.getByRole('heading', { name: 'Minha rota de hoje.' })).toBeVisible();
      await expect(page.getByLabel('33% das visitas concluídas')).toBeVisible();
      await page.getByRole('button', { name: 'Reordenar' }).click();
      await page.getByRole('button', { name: 'Descer Autopeças Central' }).click();
      await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Baterias do Norte');
      await expect(page.locator('.seller-stop-card').nth(1)).toContainText('Oficina Boa Viagem');
      expect(commands).toHaveLength(0);
      await page.getByRole('button', { name: 'Cancelar' }).click();
      await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Autopeças Central');
      await page.getByRole('button', { name: 'Reordenar' }).click();
      await page.getByRole('button', { name: 'Subir Baterias do Norte' }).click();
      await page.getByRole('button', { name: 'Salvar ordem' }).click();
      await expect(page.getByRole('status')).toContainText('Ordem salva e confirmada');
      expect(commands).toEqual([{ schemaVersion: 1, expectedVersion: 1, pendingStopIds: [id(12), id(10)] }]);
      await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Baterias do Norte');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const targets = await page.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
      expect(targets.every((height) => height >= 44)).toBe(true);
      await page.screenshot({ path: `Docs/qa/evidence/2.3/route-${viewport.width}.png`, fullPage: true });
    });
  }

  test('409 requires explicit reload and never retries or overwrites silently', async ({ page }) => {
    const commands = await setup(page, { conflict: true });
    await page.goto('/route');
    await page.getByRole('button', { name: 'Reordenar' }).click();
    await page.getByRole('button', { name: 'Descer Autopeças Central' }).click();
    await page.getByRole('button', { name: 'Salvar ordem' }).click();
    await expect(page.getByRole('status')).toContainText('A rota mudou');
    await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Baterias do Norte');
    expect(commands).toHaveLength(1);
    await page.getByRole('button', { name: 'Recarregar rota' }).click();
    await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Autopeças Central');
    expect(commands).toHaveLength(1);
  });

  test('network save failure keeps the draft without claiming success', async ({ page }) => {
    await setup(page, { networkSave: true });
    await page.goto('/route');
    await page.getByRole('button', { name: 'Reordenar' }).click();
    await page.getByRole('button', { name: 'Descer Autopeças Central' }).click();
    await page.getByRole('button', { name: 'Salvar ordem' }).click();
    await expect(page.getByRole('status')).toContainText('Seu rascunho continua nesta tela');
    await expect(page.locator('.seller-stop-card').nth(0)).toContainText('Baterias do Norte');
    await expect(page.getByRole('button', { name: 'Salvar ordem' })).toBeEnabled();
  });

  test('expired identity on refresh removes the previous private route', async ({ page }) => {
    const options = { unauthorized: false };
    await setup(page, options);
    await page.goto('/route');
    await expect(page.getByRole('heading', { name: 'Autopeças Central' })).toBeVisible();
    options.unauthorized = true;
    await page.getByRole('button', { name: 'Atualizar rota' }).click();
    await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
    await expect(page.getByText('Autopeças Central')).toHaveCount(0);
  });

  test('empty, unavailable and missing session are distinct; logout removes private state', async ({ page }) => {
    await setup(page, { empty: true });
    await page.goto('/route');
    await expect(page.getByRole('heading', { name: 'Nenhuma rota publicada para hoje' })).toBeVisible();
    await page.unrouteAll(); await setup(page, { fail: true }); await page.reload();
    await expect(page.getByRole('heading', { name: 'Vamos tentar de novo?' })).toBeVisible();
    await page.unrouteAll(); await setup(page, { unauthorized: true }); await page.reload();
    await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
    await page.unrouteAll(); await setup(page); await page.reload();
    await expect(page.getByRole('heading', { name: 'Autopeças Central' })).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goBack();
    await expect(page.getByText('Autopeças Central')).toHaveCount(0);
    await page.goto('/route');
    await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
    await expect(page.getByText('Autopeças Central')).toHaveCount(0);
  });
});

test('real route offline fallback never shows the synthetic offline bundle', async ({ page, context }) => {
  await page.goto('/demo/offline');
  await page.getByRole('button', { name: 'Carregar rota sintética local' }).click();
  await expect(page.getByText('Disponível offline', { exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Vamos reconectar?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Carregar rota sintética local' })).toHaveCount(0);
});
