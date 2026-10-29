import { expect, test } from '@playwright/test';

const visibilityNote = 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.';
const agendaResult = {
  schemaVersion: 1,
  filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending', period: 'morning' },
  generatedAt: '2026-10-28T12:00:00.000Z', lastServerConfirmedAt: '2026-10-28T11:55:00.000Z',
  indicators: { records: 1, scheduledKg: '42.50' }, nextCursor: null,
  serverVisibilityNote: visibilityNote,
  records: [{
    id: '10000000-0000-4000-8000-000000000001', offlineId: '10000000-0000-4000-8000-000000000002',
    client: { id: '10000000-0000-4000-8000-000000000003', name: 'Cliente agenda E2E', address: 'Endereço preservado E2E' },
    seller: { id: '10000000-0000-4000-8000-000000000004', displayName: 'Vendedor agenda E2E' },
    origin: 'standalone', visitId: null, estimatedWeightKg: '42.50', desiredDate: '2026-10-30',
    period: 'morning', observation: 'Observação histórica E2E', requestedAt: '2026-10-28T10:00:00.000Z',
    serverSavedAt: '2026-10-28T10:00:01.000Z', status: 'pending', version: 1,
  }],
};

test.describe('scrap agenda manager journey', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps approved filters and responsive controls at the unauthenticated boundary', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/management/scrap/agenda?from=2026-10-26&to=2026-11-01&period=morning');
    await expect(page.getByRole('heading', { name: 'Pendências confirmadas' })).toBeVisible();
    await expect(page.getByText('Acesso não autorizado.')).toBeVisible();
    await expect(page.getByLabel('Data desejada inicial')).toHaveValue('2026-10-26');
    await expect(page.getByLabel('Período')).toHaveValue('morning');
    await expect(page.getByRole('link', { name: 'Agenda pendente' })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Data desejada inicial').focus();
    const finalDate = page.getByLabel('Data desejada final');
    for (let attempt = 0; attempt < 5 && !await finalDate.evaluate((element) => element === document.activeElement); attempt += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(finalDate).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('rejects an unknown web filter before authorization or database access', async ({ page }) => {
    await page.goto('/management/scrap/agenda?from=2026-10-26&to=2026-11-01&unexpected=value');

    const alert = page.getByRole('alert').filter({ hasText: 'Atualização não concluída.' });
    await expect(alert).toContainText('Atualização não concluída.');
    await expect(alert).toContainText('Filtro da agenda inválido ou repetido.');
    await expect(page.getByText('Acesso não autorizado.')).toHaveCount(0);
  });

  test('refreshes server-confirmed schedules and preserves them after a recoverable failure', async ({ page }) => {
    let fail = false;
    const requested: string[] = [];
    await page.route('**/api/v1/pickup-schedules?*', async (route) => {
      requested.push(route.request().url());
      if (fail) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
          code: 'DEPENDENCY_UNAVAILABLE', message: 'Agenda temporariamente indisponível.', recoverable: true,
          timestamp: '2026-10-28T12:01:00.000Z', requestId: '10000000-0000-4000-8000-000000000009',
        } }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(agendaResult) });
    });
    await page.goto('/management/scrap/agenda?from=2026-10-26&to=2026-11-01&period=morning');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('heading', { name: 'Cliente agenda E2E' })).toBeVisible();
    await expect(page.getByText('42.50 kg estimados', { exact: false })).toBeVisible();
    await expect(page.getByText(visibilityNote)).toBeVisible();
    await expect(page.getByText('Kg estimados', { exact: true })).toBeVisible();
    await expect(page.getByText('Kg coletados')).toHaveCount(0);
    fail = true;
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Atualização não concluída.' });
    await expect(alert).toContainText('Agenda temporariamente indisponível.');
    await expect(alert).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Cliente agenda E2E' })).toBeVisible();
    expect(requested).toHaveLength(2);
  });
});
