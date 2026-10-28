import { expect, test } from '@playwright/test';

const visibilityNote = 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.';

function managementResult(availability: 'available' | 'empty') {
  const route = {
    routeId: '10000000-0000-4000-8000-000000000001',
    routeVersionId: '10000000-0000-4000-8000-000000000002',
    versionNumber: 2,
    seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor Sintético' },
    counts: { planned: 2, pending: 1, inVisit: 0, completed: 1, notVisited: 0 },
    sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
    nonVisits: [], historicalExecutions: [], syncIssues: [],
    visits: [{
      visitId: '60000000-0000-4000-8000-000000000001',
      routeVersionStopId: '60000000-0000-4000-8000-000000000002',
      client: { id: '60000000-0000-4000-8000-000000000003', name: 'Cliente Visitado' },
      status: 'completed',
      deviceStartedAt: '2026-10-20T11:55:00.000Z',
      serverStartedAt: '2026-10-20T12:00:00.000Z',
      lastKnownUpdateAt: '2026-10-20T12:00:00.000Z',
    }],
    lastKnownUpdateAt: '2026-10-20T12:00:00.000Z',
  };
  return {
    schemaVersion: 1,
    serviceDate: '2026-10-20',
    generatedAt: '2026-10-20T12:05:00.000Z',
    lastKnownUpdateAt: availability === 'available' ? route.lastKnownUpdateAt : null,
    availability,
    totals: availability === 'available'
      ? route.counts
      : { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 },
    sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
    routes: availability === 'available' ? [route] : [],
    serverVisibilityNote: visibilityNote,
  };
}

test.describe('management day access boundary', () => {
  test.use({ serviceWorkers: 'block' });

  test('shows the forbidden state without exposing route data to an unauthenticated browser', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/management/day?serviceDate=2026-10-20');
    await expect(page.getByRole('heading', { name: 'Acompanhamento das rotas' })).toBeVisible();
    await expect(page.getByText('Acesso não autorizado.')).toBeVisible();
    await expect(page.getByLabel('Data operacional')).toHaveValue('2026-10-20');
    await expect(page.locator('.manager-day-route')).toHaveCount(0);
    await page.getByLabel('Data operacional').focus();
    const apply = page.getByRole('button', { name: 'Aplicar data' });
    for (let attempt = 0; attempt < 5 && !await apply.evaluate((element) => element === document.activeElement); attempt += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(apply).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Atualizar agora' })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('refreshes the confirmed manager date and preserves it across a recoverable error', async ({ page }) => {
    let response: 'available' | 'empty' | 'error' = 'available';
    const requestedDates: string[] = [];
    let releaseInitialResponse: (() => void) | undefined;
    const initialResponseGate = new Promise<void>((resolve) => { releaseInitialResponse = resolve; });
    await page.route('**/api/v1/management/day?*', async (route) => {
      requestedDates.push(new URL(route.request().url()).searchParams.get('serviceDate') ?? '');
      if (requestedDates.length === 1) await initialResponseGate;
      if (response === 'error') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          error: {
            code: 'DEPENDENCY_UNAVAILABLE', message: 'Visão temporariamente indisponível.',
            recoverable: true, timestamp: '2026-10-20T12:06:00.000Z',
            requestId: '30000000-0000-4000-8000-000000000001',
          },
        }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(managementResult(response)) });
    });

    await page.goto('/management/day?serviceDate=2026-10-20');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('status')).toContainText('Atualizando');
    releaseInitialResponse?.();
    await expect(page.locator('a[href="/management/visits/60000000-0000-4000-8000-000000000001"]'))
      .toHaveText('Cliente Visitado');
    await expect(page.getByRole('heading', { name: 'Vendedor Sintético' })).toBeVisible();
    await expect(page.getByText(visibilityNote)).toBeVisible();

    await page.getByLabel('Data operacional').fill('2026-10-21');
    response = 'error';
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Atualização não concluída.' });
    await expect(alert).toContainText('Visão temporariamente indisponível.');
    await expect(alert).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Vendedor Sintético' })).toBeVisible();
    expect(requestedDates).toEqual(['2026-10-20', '2026-10-20']);

    response = 'empty';
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(page.getByRole('heading', { name: 'Nenhuma rota publicada nesta data' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vendedor Sintético' })).toHaveCount(0);
  });
});
