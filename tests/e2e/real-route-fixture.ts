import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test as base, expect } from '@playwright/test';
import { routeDraftSchema, routeCompositionDraftSchema, routeTodayResponseSchema } from '@cirne/contracts';

type Actor = { id: string; email: string; password: string; accessToken: string };
type RealRouteFixture = {
  seller: Actor;
  manager: Actor;
  clients: Array<{ id: string; name: string }>;
};

export const test = base.extend<{ realRoute: RealRouteFixture }>({
  realRoute: async ({ request, baseURL }, use) => {
    if (!baseURL || new URL(baseURL).hostname !== '127.0.0.1') {
      throw new Error('Real browser fixtures require the local application.');
    }
    const manifest = JSON.parse(await readFile('.local/identity-actors.json', 'utf8')) as {
      actors: { seller_regression: Actor; manager_regression: Actor };
    };
    const seller = manifest.actors.seller_regression;
    const manager = manifest.actors.manager_regression;
    if (!seller || !manager) throw new Error('Provision local browser actors before running this suite.');
    const clients = [1, 2, 3].map((index) => ({
      id: crypto.randomUUID(), name: `Cliente E2E Sintético ${index}`,
    }));
    // Only generated values enter SQL, in the project's fixed local container. Keep old facts.
    const values = clients.map(({ id, name }, index) =>
      `('${id}', 'E2E-${id}', '${name}', 'Endereco E2E sintetico ${index + 1}', 'CARTEIRA-E2E', 'active')`).join(',');
    const useRancherDesktopWsl = process.platform === 'win32' &&
      process.env.CIRNE_DOCKER_BACKEND === 'rancher-desktop-wsl';
    const dockerProgram = useRancherDesktopWsl ? 'wsl' : 'docker';
    const dockerPrefix = useRancherDesktopWsl ? ['-d', 'rancher-desktop', '--', 'docker'] : [];
    try {
      await promisify(execFile)(dockerProgram, [...dockerPrefix, 'exec', 'supabase_db_cirne-rotas-dev',
        'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
        '-c', `insert into api.clients (id, external_reference, name, address, portfolio_reference, status) values ${values}`],
      { windowsHide: true, timeout: 25_000 });
    } catch (cause) {
      throw new Error('Could not create exclusively synthetic browser clients in the local database.', { cause });
    }
    const currentResponse = await request.get('/api/v1/me/routes/today', {
      headers: { Authorization: `Bearer ${seller.accessToken}` },
    });
    expect(currentResponse.status()).toBe(200);
    const current = routeTodayResponseSchema.parse(await currentResponse.json());
    const headers = { Authorization: `Bearer ${manager.accessToken}` };
    const stops = clients.slice(0, 2).map(({ id }, index) => ({ clientId: id, plannedOrder: index + 1, priority: 0 }));
    let draft;
    if (current.availability === 'available') {
      const response = await request.patch(`/api/v1/routes/${current.route.routeId}`, {
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        data: { schemaVersion: 1, expectedVersion: current.route.executionVersion,
          reason: 'Preparacao isolada de cenario E2E sintetico', stops },
      });
      expect(response.status()).toBe(200);
      draft = routeCompositionDraftSchema.parse(await response.json());
    } else {
      const response = await request.post('/api/v1/routes', {
        headers, data: { schemaVersion: 1, serviceDate: current.serviceDate, sellerId: seller.id, stops },
      });
      expect(response.status()).toBe(201);
      draft = routeDraftSchema.parse(await response.json());
    }
    const published = await request.post(`/api/v1/routes/${draft.routeId}/publish`, {
      headers, data: { schemaVersion: 1, expectedVersion: draft.expectedVersion },
    });
    expect(published.status()).toBe(200);
    await use({ seller, manager, clients });
  },
});
