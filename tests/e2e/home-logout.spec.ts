import { expect, test, type Page } from '@playwright/test';
import type { MeResponse } from '@cirne/contracts';

const firstUser: MeResponse = {
  id: '41600000-0000-4000-8000-000000000001', displayName: 'Vendedora inicial sintética',
  roles: ['seller'], status: 'active', scopeIds: [],
  capabilities: ['identity.read_self', 'route.read_self', 'scrap.schedule_self', 'scrap.collect_self'],
};
const nextUser: MeResponse = {
  ...firstUser, id: '41600000-0000-4000-8000-000000000002', displayName: 'Vendedor seguinte sintético',
};

async function setup(page: Page, failLogout = false) {
  let identity = firstUser;
  let loggedOut = false;
  let deleteCalls = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/session') {
      if (request.method() === 'DELETE') {
        deleteCalls += 1;
        expect(request.headers()['x-csrf-token']).toBe('cirne-route-v1');
        if (failLogout && deleteCalls === 1) return route.fulfill({ status: 503, json: {} });
        loggedOut = true;
        return route.fulfill({ status: 204 });
      }
      identity = nextUser; loggedOut = false;
      return route.fulfill({ json: identity });
    }
    if (url.pathname === '/api/v1/me') return route.fulfill({ status: loggedOut ? 401 : 200, json: identity });
    return route.fulfill({ status: 503, json: {} });
  });
  return { deleteCalls: () => deleteCalls };
}

async function savedState(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cirne-rotas-offline');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(['localSessions', 'scrapSchedules'], 'readonly');
      const read = (name: string) => new Promise<number>((resolve, reject) => {
        const request = transaction.objectStore(name).count();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const [sessions, schedules] = await Promise.all([read('localSessions'), read('scrapSchedules')]);
      return { userId: localStorage.getItem('cirne-rotas.last-user-id'), sessions, schedules };
    } finally { database.close(); }
  });
}

test.describe('seller home session exit', () => {
  test.use({ serviceWorkers: 'block' });

  test('ends the session, locks local access, preserves pending work and isolates the following account', async ({ page }) => {
    const state = await setup(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/home');
    await expect(page.getByText(firstUser.displayName, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Registrar coleta de sucata/ })).toHaveAttribute('href', '/route');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cirne-rotas.last-user-id'))).toBe(firstUser.id);
    await page.evaluate(async (user) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('cirne-rotas-offline');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const deviceId = localStorage.getItem('cirne-rotas.device-id')!;
      const offlineId = '41600000-0000-4000-8000-000000000003';
      const now = new Date().toISOString();
      const client = { id: '41600000-0000-4000-8000-000000000004', name: 'Cliente privado da primeira conta', address: 'Rua sintética, 4' };
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('scrapSchedules', 'readwrite');
        transaction.objectStore('scrapSchedules').put({ userId: user.id, deviceId, offlineId, client,
          request: { schemaVersion: 1, offlineId, clientId: client.id, estimatedWeightKg: '10', desiredDate: '2030-01-02', period: 'morning', observation: '', requestedAt: now },
          idempotencyKey: crypto.randomUUID(), status: 'action_required', createdAt: now });
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    }, firstUser);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Agendamentos salvos no aparelho' })).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(state.deleteCalls()).toBe(1);
    expect(await savedState(page)).toEqual({ userId: null, sessions: 0, schedules: 1 });

    await page.goto('/home');
    await expect(page.getByRole('alert').filter({ hasText: 'Entre novamente' })).toBeVisible();
    await expect(page.getByText(firstUser.displayName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Agendamentos salvos no aparelho' })).toHaveCount(0);
    await page.goto('/route');
    await expect(page.getByRole('link', { name: 'Ir para o login' })).toBeVisible();
    await page.goto('/login');
    await page.getByLabel('E-mail', { exact: true }).fill('next@example.invalid');
    await page.getByLabel('Senha', { exact: true }).fill('synthetic-test-password');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByText(nextUser.displayName, { exact: true })).toBeVisible();
    await expect.poll(async () => (await savedState(page)).userId).toBe(nextUser.id);
    await expect(page.getByText(firstUser.displayName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Agendamentos salvos no aparelho' })).toHaveCount(0);
    expect((await savedState(page)).schedules).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('hides private state on a failed logout and offers a working retry without claiming success', async ({ page }) => {
    const state = await setup(page, true);
    await page.goto('/home');
    await expect(page.getByText(firstUser.displayName, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'tente sair novamente para confirmar' })).toBeVisible();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByText(firstUser.displayName, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Operações disponíveis' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(state.deleteCalls()).toBe(2);
  });
});
