import { expect, test } from '@playwright/test';

const visibilityNote = 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.';
const stockResult = {
  schemaVersion: 1, section: 'stock',
  filters: { section: 'stock', from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-28T12:00:00.000Z', lastConfirmedAt: '2026-10-28T11:55:00.000Z', nextCursor: null,
  serverVisibilityNote: visibilityNote,
  indicators: { records: 1, heliarQuantity: 2, mouraQuantity: 3, ownLineQuantity: 2, competitorLineQuantity: 1 },
  records: [{
    recordId: '10000000-0000-4000-8000-000000000001', visitId: '10000000-0000-4000-8000-000000000002',
    serviceDate: '2026-10-28', seller: { id: '10000000-0000-4000-8000-000000000003', name: 'Vendedor Sintético' },
    client: { id: '10000000-0000-4000-8000-000000000004', name: 'Cliente Visitado' },
    confirmedAt: '2026-10-28T11:55:00.000Z', heliarQuantity: 2, mouraQuantity: 3,
    ownLines: [{ brand: 'Heliar', model: '60 Ah', quantity: 2 }],
    competitorLines: [{ brand: 'Moura', amperage: 60, technology: 'Convencional', quantity: 1 }],
  }],
};

test.describe('field intelligence manager journey', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps filters in the URL, supports keyboard focus and does not overflow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/management/intelligence?section=stock&from=2026-10-26&to=2026-11-01');
    await expect(page.getByRole('heading', { name: 'Leituras confirmadas do campo' })).toBeVisible();
    await expect(page.getByText('Acesso não autorizado.')).toBeVisible();
    await expect(page.getByLabel('Data inicial')).toHaveValue('2026-10-26');
    await expect(page.getByRole('link', { name: 'Estoque' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Preços' })).toHaveAttribute('href', /section=prices/);
    await page.getByLabel('Data inicial').focus();
    const finalDate = page.getByLabel('Data final');
    for (let attempt = 0; attempt < 5 && !await finalDate.evaluate((element) => element === document.activeElement); attempt += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(finalDate).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('refreshes confirmed data and preserves the last valid cards after a recoverable failure', async ({ page }) => {
    let fail = false;
    const requested: string[] = [];
    await page.route('**/api/v1/reports/field-intelligence?*', async (route) => {
      requested.push(route.request().url());
      if (fail) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: {
          code: 'DEPENDENCY_UNAVAILABLE', message: 'Leitura temporariamente indisponível.', recoverable: true,
          timestamp: '2026-10-28T12:01:00.000Z', requestId: '10000000-0000-4000-8000-000000000009',
        } }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stockResult) });
    });
    await page.goto('/management/intelligence?section=stock&from=2026-10-26&to=2026-11-01');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await expect(page.getByRole('heading', { name: 'Cliente Visitado' })).toBeVisible();
    await expect(page.getByText(visibilityNote)).toBeVisible();
    fail = true;
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Atualização não concluída.' });
    await expect(alert).toContainText('Leitura temporariamente indisponível.');
    await expect(alert).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Cliente Visitado' })).toBeVisible();
    expect(requested).toHaveLength(2);
  });
});
