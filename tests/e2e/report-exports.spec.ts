import { expect, test } from '@playwright/test';

const stockResult = {
  schemaVersion: 1, section: 'stock',
  filters: { section: 'stock', from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-29T12:00:00.000Z', lastConfirmedAt: '2026-10-29T11:55:00.000Z', nextCursor: null,
  serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  indicators: { records: 1, heliarQuantity: 2, mouraQuantity: 0, ownLineQuantity: 1, competitorLineQuantity: 0 },
  records: [{
    recordId: '10000000-0000-4000-8000-000000000001', visitId: '10000000-0000-4000-8000-000000000002',
    serviceDate: '2026-10-29', seller: { id: '10000000-0000-4000-8000-000000000003', name: 'Vendedor Sintético' },
    client: { id: '10000000-0000-4000-8000-000000000004', name: 'Cliente Exportável' },
    confirmedAt: '2026-10-29T11:55:00.000Z', heliarQuantity: 2, mouraQuantity: 0,
    ownLines: [{ brand: 'Heliar', model: '60 Ah', quantity: 2 }], competitorLines: [],
  }],
};

test.describe('manager report exports', () => {
  test.use({ serviceWorkers: 'block' });

  test('downloads the confirmed filtered view without losing screen state', async ({ page }) => {
    const exportRequests: string[] = [];
    await page.route('**/api/v1/reports/field-intelligence?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(stockResult),
    }));
    await page.route('**/api/v1/reports/exports?*', async (route) => {
      exportRequests.push(route.request().url());
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="cirne-inteligencia-de-campo-2026-10-26-a-2026-11-01.csv"',
          'cache-control': 'private, no-store', 'x-export-row-count': '1',
        },
        body: Buffer.from('\uFEFFData;Cliente\r\n2026-10-29;Cliente Exportável\r\n', 'utf8'),
      });
    });
    await page.goto('/management/intelligence?section=stock&from=2026-10-26&to=2026-11-01');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('heading', { name: 'Cliente Exportável' })).toBeVisible();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('cirne-inteligencia-de-campo-2026-10-26-a-2026-11-01.csv');
    await expect(page.getByRole('status')).toContainText('Relatório CSV gerado.');
    await expect(page.getByLabel('Data inicial')).toHaveValue('2026-10-26');
    await expect(page.getByRole('heading', { name: 'Cliente Exportável' })).toBeVisible();
    expect(exportRequests).toHaveLength(1);
    expect(exportRequests[0]).toContain('view=field_intelligence');
    expect(exportRequests[0]).toContain('section=stock');
    expect(exportRequests[0]).toContain('from=2026-10-26');
    expect(exportRequests[0]).toContain('to=2026-11-01');
  });

  test('preserves the current reading on export failure and fits a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/v1/reports/field-intelligence?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(stockResult),
    }));
    await page.route('**/api/v1/reports/exports?*', (route) => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
        code: 'DEPENDENCY_UNAVAILABLE', message: 'Exportação temporariamente indisponível.', recoverable: true,
        timestamp: '2026-10-29T12:01:00.000Z', requestId: '10000000-0000-4000-8000-000000000009',
      } }),
    }));
    await page.goto('/management/intelligence?section=stock&from=2026-10-26&to=2026-11-01');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await page.getByRole('button', { name: 'XLSX', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Exportação temporariamente indisponível.');
    await expect(page.getByRole('heading', { name: 'Cliente Exportável' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
