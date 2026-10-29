import { expect, test } from '@playwright/test';

const note = 'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.';
const routeId = '10000000-0000-4000-8000-000000000001';
const routeVersionId = '10000000-0000-4000-8000-000000000002';
const seller = { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor do Mapa' };
const positionedStopId = '30000000-0000-4000-8000-000000000001';
const unpositionedStopId = '30000000-0000-4000-8000-000000000002';

const day = {
  schemaVersion: 2, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:05:00.000Z',
  lastKnownUpdateAt: '2026-10-20T12:00:00.000Z', availability: 'available',
  totals: { planned: 2, pending: 1, inVisit: 0, completed: 1, notVisited: 0 },
  sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
  routes: [{
    routeId, routeVersionId, versionNumber: 2, seller,
    counts: { planned: 2, pending: 1, inVisit: 0, completed: 1, notVisited: 0 },
    sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
    nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [],
    lastKnownUpdateAt: '2026-10-20T12:00:00.000Z',
    stops: [{
      routeVersionStopId: positionedStopId, plannedOrder: 1,
      executionOrder: 1, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Loja Centro' },
      status: 'completed', nonVisitReason: null, lastKnownUpdateAt: '2026-10-20T12:00:00.000Z', visits: [],
    }, {
      routeVersionStopId: unpositionedStopId, plannedOrder: 2,
      executionOrder: 2, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000002', name: 'Loja Sem Coordenada' },
      status: 'pending', nonVisitReason: null, lastKnownUpdateAt: '2026-10-20T12:00:00.000Z', visits: [],
    }],
  }],
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
};

const map = {
  schemaVersion: 1, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:05:00.000Z',
  availability: 'available', totals: { routes: 1, stops: 2, positioned: 1, unpositioned: 1 },
  routes: [{
    routeId, routeVersionId, versionNumber: 2, seller,
    stops: [{
      routeVersionStopId: positionedStopId, plannedOrder: 1,
      executionOrder: 1, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Loja Centro', address: 'Rua Sintética, 100' }, status: 'completed',
      location: { latitude: '-7.11509', longitude: '-34.86410' },
    }, {
      routeVersionStopId: unpositionedStopId, plannedOrder: 2,
      executionOrder: 2, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000002', name: 'Loja Sem Coordenada', address: 'Avenida Sintética, 200' }, status: 'pending',
      location: null,
    }],
  }], serverVisibilityNote: note,
};

async function openConfirmedDay(page: import('@playwright/test').Page, generatedAt = () => day.generatedAt) {
  await page.route('**/api/v1/management/day?*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ...day, generatedAt: generatedAt() }),
  }));
  await page.goto('/management/day?serviceDate=2026-10-20');
  await page.getByRole('button', { name: 'Atualizar agora' }).click();
  await expect(page.getByRole('heading', { name: 'Mapa de apoio' })).toBeVisible();
}

test.describe('management route map', () => {
  test.use({ serviceWorkers: 'block' });

  test('loads only on demand and keeps a textual route alternative', async ({ page }) => {
    let requests = 0;
    let generatedAt = day.generatedAt;
    await page.route('**/api/v1/management/map?*', (route) => {
      requests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(map) });
    });
    await page.route('https://tiles.example.test/**', (route) => route.fulfill({
      status: 200, contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    }));
    await openConfirmedDay(page, () => generatedAt);
    expect(requests).toBe(0);

    await page.getByRole('button', { name: 'Mostrar mapa' }).click();
    await expect(page.getByLabel('Mapa das paradas publicadas')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Paradas representadas no mapa' }))
      .toContainText('Loja Centro');
    await expect(page.getByRole('complementary', { name: 'Paradas representadas no mapa' })
      .getByText('Loja Sem Coordenada')).toBeVisible();
    expect(requests).toBe(1);
    await page.getByRole('complementary', { name: 'Paradas representadas no mapa' })
      .getByRole('button', { name: /1\. Loja Centro/ }).click();
    await expect(page.locator('.leaflet-popup')).toContainText('Vendedor do Mapa');
    await expect(page.getByText('não representam trajeto por ruas')).toBeVisible();
    generatedAt = '2026-10-20T12:06:00.000Z';
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('button', { name: 'Mostrar mapa' })).toBeVisible();
    await expect(page.getByLabel('Mapa das paradas publicadas')).toBeHidden();
    expect(requests).toBe(1);
    await page.getByRole('button', { name: 'Mostrar mapa' }).click();
    await expect(page.getByLabel('Mapa das paradas publicadas')).toBeVisible();
    expect(requests).toBe(2);
  });

  test('contains provider failure and does not overflow at 390 px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/v1/management/map?*', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'DEPENDENCY_UNAVAILABLE', message: 'Projeção do mapa indisponível.', recoverable: true,
        timestamp: '2026-10-20T12:06:00.000Z', requestId: '70000000-0000-4000-8000-000000000001',
      } }),
    }));
    await openConfirmedDay(page);
    await page.getByRole('button', { name: 'Mostrar mapa' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Projeção do mapa indisponível.' })).toBeVisible();
    await expect(page.locator('.management-route-cards').getByText('Vendedor do Mapa', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('reports tile failure without removing markers or the operational list', async ({ page }) => {
    await page.route('**/api/v1/management/map?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(map),
    }));
    await page.route('https://tiles.example.test/**', (route) => route.fulfill({ status: 503 }));
    await openConfirmedDay(page);
    await page.getByRole('button', { name: 'Mostrar mapa' }).click();

    await expect(page.getByText('O provedor de mapa está indisponível. Marcadores e lista permanecem disponíveis.'))
      .toBeVisible();
    await expect(page.locator('.management-map-marker')).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'Paradas representadas no mapa' }))
      .toContainText('Loja Sem Coordenada');
    await expect(page.locator('.management-route-table').getByText('Vendedor do Mapa', { exact: true }).first())
      .toBeVisible();
  });
});
