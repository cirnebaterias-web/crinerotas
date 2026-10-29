import { expect, test } from '@playwright/test';

const ids = ['SM-01','SM-02','SM-03','SM-04','SM-05','SM-06','SM-07','SM-08','SM-09'];
const visibility = 'Somente fatos confirmados pelo servidor são observados; fontes externas e conteúdo ainda apenas no aparelho permanecem não avaliáveis.';
const result = {
  schemaVersion: 1, filters: { from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-28T12:00:00.000Z', lastServerConfirmedAt: '2026-10-28T11:55:00.000Z',
  metrics: ids.map((id) => {
    const external = ['SM-01','SM-06','SM-07','SM-08','SM-09'].includes(id);
    return {
      id, name: `Métrica ${id}`, target: { operator: 'gte', value: '90', unit: 'percent' },
      formula: 'Fórmula aprovada', source: 'Fonte aprovada', periodicity: ['weekly'],
      coverage: external ? 'external_source_required' : id === 'SM-05' ? 'partial_server_view' : 'server_confirmed_cohort',
      assessment: external ? 'not_evaluable' : 'provisional_met',
      observation: external ? null : { numerator: 1, denominator: 1, percentage: '100', exclusions: { windowOpen: 0, clockSuspicious: 0 } },
      requiredSource: external ? 'Fonte externa aprovada' : null,
      note: 'Resultado provisório e limitado.',
    };
  }),
  records: [], nextCursor: null, serverVisibilityNote: visibility,
};

test.describe('pilot metrics manager journey', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps filters, keyboard access and responsive reading at the authorization boundary', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/management/pilot?from=2026-10-26&to=2026-11-01');
    await expect(page.getByRole('heading', { name: 'Métricas canônicas do piloto' })).toBeVisible();
    await expect(page.getByText('Acesso não autorizado.')).toBeVisible();
    await expect(page.getByLabel('Data inicial')).toHaveValue('2026-10-26');
    await expect(page.getByRole('link', { name: 'Métricas do piloto' })).toHaveAttribute('aria-current', 'page');
    await page.getByLabel('Data inicial').focus();
    const finalDate = page.getByLabel('Data final');
    for (let attempt = 0; attempt < 5 && !await finalDate.evaluate((element) => element === document.activeElement); attempt += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(finalDate).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('shows all nine metrics and preserves them after a recoverable refresh failure', async ({ page }) => {
    let fail = false;
    await page.route('**/api/v1/reports/pilot-metrics?*', async (route) => {
      await route.fulfill(fail ? {
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
          code: 'DEPENDENCY_UNAVAILABLE', message: 'Métricas temporariamente indisponíveis.', recoverable: true,
          timestamp: '2026-10-28T12:01:00.000Z', requestId: '10000000-0000-4000-8000-000000000009',
        } }),
      } : { status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.goto('/management/pilot?from=2026-10-26&to=2026-11-01');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByLabel('Nove métricas do piloto').locator('article')).toHaveCount(9);
    await expect(page.getByText(visibility)).toBeVisible();
    fail = true;
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Atualização não concluída.' });
    await expect(alert).toContainText('Métricas temporariamente indisponíveis.');
    await expect(alert).toBeFocused();
    await expect(page.getByLabel('Nove métricas do piloto').locator('article')).toHaveCount(9);
  });

  test('remounts the dashboard and removes stale cards when the normalized filter changes', async ({ page }) => {
    await page.route('**/api/v1/reports/pilot-metrics?*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    });
    await page.goto('/management/pilot?from=2026-10-26&to=2026-11-01');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByLabel('Nove métricas do piloto').locator('article')).toHaveCount(9);

    await page.getByLabel('Data inicial').fill('2026-10-27');
    await page.getByLabel('Data final').fill('2026-11-02');
    await page.getByRole('button', { name: 'Aplicar filtros' }).click();

    await expect(page).toHaveURL(/from=2026-10-27&to=2026-11-02/);
    await expect(page.getByLabel('Nove métricas do piloto')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.seller-notice.seller-error')).toContainText('Acesso não autorizado.');
  });
});
