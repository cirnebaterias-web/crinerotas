import { expect, test, type Page } from '@playwright/test';
import type { CanonicalRoute, MeResponse } from '@cirne/contracts';

const id = (number: number) => `22222222-2222-4222-8222-${String(number).padStart(12, '0')}`;
const identity: MeResponse = {
  id: id(1),
  displayName: 'Vendedor offline sintético',
  roles: ['seller'],
  capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self'],
  scopeIds: [id(1)],
  status: 'active',
};
const route: CanonicalRoute = {
  schemaVersion: 2,
  routeId: id(2),
  routeVersionId: id(3),
  versionNumber: 1,
  serviceDate: '2026-09-16',
  status: 'published',
  publishedAt: '2026-09-16T09:00:00Z',
  executionVersion: 1,
  seller: { id: identity.id, displayName: identity.displayName },
  stops: [{
    routeVersionStopId: id(4),
    plannedOrder: 1,
    executionOrder: 1,
    priority: 2,
    status: 'pending',
    executionVersion: 1,
    client: {
      id: id(5),
      externalReference: 'OFF-01',
      name: 'Cliente offline sintético',
      address: 'Rua offline, 100 — Recife, PE',
      latitude: null,
      longitude: null,
      portfolioReference: null,
    },
  }],
};

async function mockSeller(page: Page) {
  await page.route('**/api/v1/**', async (request) => {
    const pathname = new URL(request.request().url()).pathname;
    if (pathname === '/api/v1/me') {
      await request.fulfill({ json: identity });
    } else if (pathname.endsWith('/today')) {
      await request.fulfill({ json: { schemaVersion: 2, availability: 'available', route } });
    } else if (pathname === '/api/v1/auth/session' && request.request().method() === 'DELETE') {
      await request.fulfill({ status: 204 });
    } else {
      await request.continue();
    }
  });
}

test('caches the canonical route, reopens it offline and revokes local access', async ({ page, context }) => {
  await mockSeller(page);
  await page.goto('/route');
  await expect(page.getByRole('heading', { name: 'Cliente offline sintético' })).toBeVisible();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();

  const persisted = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cirne-rotas-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bundles = await new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction('routeBundles').objectStore('routeBundles').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return bundles;
  });
  expect(persisted).toMatchObject([{
    schemaVersion: 2,
    userId: identity.id,
    routeId: route.routeId,
    routeVersionId: route.routeVersionId,
  }]);

  await page.unrouteAll({ behavior: 'wait' });
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Cliente offline sintético' })).toBeVisible();
  await expect(page.getByText('última rota salva neste aparelho', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navegar', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copiar endereço de Cliente offline sintético' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reordenar' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Bloquear acesso local' }).click();
  await expect(page.getByRole('heading', { name: 'Acesso local bloqueado' })).toBeVisible();
  await expect(page.getByText('Cliente offline sintético')).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Sem rota offline' })).toBeVisible();
  await expect(page.getByText('Cliente offline sintético')).toHaveCount(0);
});
