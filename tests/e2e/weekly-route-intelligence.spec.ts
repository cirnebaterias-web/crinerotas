import { expect, test } from '@playwright/test';

const sellerId = '11111111-1111-4111-8111-111111111111';
const candidate = (suffix: string, name: string, latitude: number, overrides: Record<string, unknown> = {}) => ({
  clientId: `40000000-0000-4000-8000-${suffix.padStart(12, '0')}`, name, status: 'active',
  daysSinceLastPurchase: 75, periodicityDays: 30, averageMonthlyVolume: 80,
  recentVolume3: 120, previousVolume3: 240, opportunitySegments: ['second_line'],
  scrapDebtKg: 300, scrapBalanceState: 'debtor', location: { latitude, longitude: -35.25 },
  hasNavigableAddress: true, score: 82, distanceFromBaseKm: 12, cycleDelayDays: 45,
  cycleDelayPercent: 150, purchaseTrend: 'falling', potential: 'high',
  reasons: ['75 dias desde a última compra', '45 dias além do ciclo (150% de atraso)',
    'volume recente caiu 50%', '300 kg de débito de sucata', '12 km aproximados da origem'], ...overrides,
});

test.describe('weekly commercial route intelligence', () => {
  test.use({ serviceWorkers: 'block' });

  test('filters priorities, supports polygon selection and remains usable at 390px', async ({ page }) => {
    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ id: '50000000-0000-4000-8000-000000000001', displayName: 'Gestor Sintético',
        roles: ['manager'], capabilities: ['identity.read_self', 'route.plan_scoped'], scopeIds: [sellerId], status: 'active' }) }));
    await page.route('**/api/v1/clients/sellers', (route) => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ schemaVersion: 1,
        sellers: [{ id: sellerId, displayName: 'Lays Andrade', email: 'seller@example.invalid' }] }) }));
    await page.route('**/api/v1/management/weekly-route-proposals?*', (route) => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, weekStart: '2026-11-16', sellerId,
        origin: { kind: 'base_city', sellerId, city: 'Parnamirim', state: 'RN', ibgeCode: '2403251',
          latitude: -5.91, longitude: -35.26, reference: 'municipal_seat', source: 'IBGE', configVersion: 1 },
        generatedAt: '2026-11-09T14:00:00-03:00', maxLegDistanceKm: 30,
        candidates: [candidate('1', 'Cliente prioritário', -5.9), candidate('2', 'Cliente estável', -5.95, {
          daysSinceLastPurchase: 20, recentVolume3: 180, previousVolume3: 170, purchaseTrend: 'stable',
          cycleDelayDays: 0, cycleDelayPercent: 0, potential: 'medium', opportunitySegments: ['motorcycle'], score: 48,
        })], counts: { total: 2, eligible: 2, positioned: 2, inactiveLost: 0 } }) }));
    await page.route('https://tiles.example.test/**', (route) => route.fulfill({ status: 204 }));

    await page.goto('/management/route-proposals');
    await page.getByRole('button', { name: 'Abrir mapa inteligente' }).click();
    await expect(page.getByText('2 clientes visíveis')).toBeVisible();
    await page.getByText('Compra em queda').click();
    await expect(page.getByText('1 clientes visíveis')).toBeVisible();
    await expect(page.getByText('Cliente prioritário')).toBeVisible();
    await expect(page.getByText('Cliente estável')).toHaveCount(0);

    await page.getByRole('button', { name: 'Desenhar seleção no mapa' }).click();
    const map = page.getByLabel('Clientes elegíveis no mapa');
    const box = await map.boundingBox();
    expect(box).not.toBeNull();
    for (const [x, y] of [[.05, .05], [.95, .05], [.95, .95], [.05, .95]] as const) {
      await map.click({ position: { x: box!.width * x, y: box!.height * y } });
    }
    await page.getByRole('button', { name: 'Concluir seleção' }).click();
    await expect(page.getByText(/1 selecionados/)).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Limpar seleção' })).toBeVisible();
  });
});
