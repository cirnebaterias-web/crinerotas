import { expect, test, type Page } from '@playwright/test';
import type { Map as LeafletMap } from 'leaflet';
import { proposeWeeklyRoutes } from '@cirne/domain';
import { weeklyRouteCandidateSchema } from '@cirne/contracts';
import axe from 'axe-core';

const sellerId = '11111111-1111-4111-8111-111111111111';
const longName = `Cliente prioritário <nome seguro> ${'NomeComercialExtenso'.repeat(6)}`;
type ObservedWindow = Window & { __routeMap?: LeafletMap; __originalRouteMap?: LeafletMap; axe?: typeof axe };
const candidate = (suffix: string, name: string, latitude: number, overrides: Record<string, unknown> = {}) => ({
  clientId: `40000000-0000-4000-8000-${suffix.padStart(12, '0')}`, name, status: 'active',
  daysSinceLastPurchase: 75, periodicityDays: 30, averageMonthlyVolume: 80,
  recentVolume3: 120, previousVolume3: 240, opportunitySegments: ['second_line'],
  scrapDebtKg: 300, scrapBalanceState: 'debtor', location: { latitude, longitude: -35.25 },
  hasNavigableAddress: true, score: 82, distanceFromBaseKm: 12, cycleDelayDays: 45,
  cycleDelayPercent: 150, purchaseTrend: 'falling', potential: 'high',
  visitHistoryStatus: 'available', lastCompletedVisitAt: '2026-09-01T12:00:00-03:00',
  coverageState: 'overdue', coverageOverdueDays: 39, nextVisitDueOn: '2026-09-29',
  reasons: Array.from({ length: 5 }, (_, index) => `${index + 1}. volume recente caiu 50%; <img src=x onerror=alert(1)>; ${'JustificativaExtensa '.repeat(7)}`.slice(0, 180)),
  ...overrides,
});

async function openMap(page: Page, review = false) {
  // Observe Leaflet through its public init hook; no production test hooks needed.
  await page.addInitScript(() => {
    let current: typeof import('leaflet') | undefined;
    Object.defineProperty(window, 'L', { configurable: true, get: () => current, set: (value: typeof import('leaflet')) => {
      current = value;
      value.Map.addInitHook(function(this: LeafletMap) { (window as ObservedWindow).__routeMap = this; });
    } });
  });
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
      candidates: [candidate('1', longName, -5.9), candidate('2', 'Cliente estável', -5.95, {
        daysSinceLastPurchase: 20, recentVolume3: 180, previousVolume3: 170, purchaseTrend: 'stable',
        cycleDelayDays: 0, cycleDelayPercent: 0, potential: 'medium', opportunitySegments: ['motorcycle'], score: 48,
        scrapBalanceState: 'creditor', scrapDebtKg: null,
      })], counts: { total: 2, eligible: 2, positioned: 2, inactiveLost: 0 } }) }));
  await page.route('https://tiles.example.test/**', (route) => route.fulfill({ status: 204 }));
  if (review) {
    const candidates = Array.from({ length: 15 }, (_, index) => weeklyRouteCandidateSchema.strip().parse(
      candidate(String(index + 1), `${longName.slice(0, 145)} ${index + 1}`, -5.9)));
    const proposal = proposeWeeklyRoutes({ weekStart: '2026-11-16', generatedAt: '2026-11-09T14:00:00-03:00',
      origin: { kind: 'base_city', sellerId, city: 'Parnamirim', state: 'RN', ibgeCode: '2403251',
        latitude: -5.91, longitude: -35.26, reference: 'municipal_seat', source: 'IBGE', configVersion: 1 }, candidates });
    const stops = proposal.days.flatMap((day) => day.suggestions);
    proposal.days = proposal.days.map((day, dayIndex) => ({ ...day,
      suggestions: stops.slice(dayIndex * 3, dayIndex * 3 + 3).map((stop, index) => ({ ...stop, dayIndex,
        plannedOrder: index + 1, locationPending: true, reasons: candidate('1', 'Cliente', -5.9).reasons })) }));
    proposal.excluded = [{ clientId: candidates[0]!.clientId, name: candidates[0]!.name, reason: 'daily_capacity_reached' }];
    await page.route('**/api/v1/management/weekly-route-proposals', (route) => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, outcome: 'existing', record: {
        schemaVersion: 1, proposalId: '60000000-0000-4000-8000-000000000001', version: 1, status: 'draft', proposal,
        createdBy: sellerId, createdAt: proposal.generatedAt, updatedAt: proposal.generatedAt,
        publishedBy: null, publishedAt: null, routeIds: [],
      } }) }));
  }
  await page.goto('/management/route-proposals');
  await page.getByRole('button', { name: review ? 'Abrir ou criar sugestão' : 'Abrir mapa inteligente' }).click();
  await expect(page.getByText('2 clientes visíveis')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enquadrar clientes' })).toBeEnabled();
  await page.waitForFunction(() => Boolean((window as ObservedWindow).__routeMap));
}

async function view(page: Page) {
  return page.evaluate(() => {
    const current = (window as ObservedWindow).__routeMap!;
    return { center: [current.getCenter().lat, current.getCenter().lng], zoom: current.getZoom() };
  });
}

async function settled(page: Page) {
  await page.waitForFunction(() => {
    const current = (window as ObservedWindow).__routeMap as LeafletMap & {
      _animatingZoom?: boolean; _panAnim?: { _inProgress?: boolean };
    };
    return current && !current._animatingZoom && !current._panAnim?._inProgress;
  });
}

async function zoomIn(page: Page) {
  const previousZoom = await page.evaluate(() => (window as ObservedWindow).__routeMap!.getZoom());
  await page.getByTitle('Zoom in').click();
  await page.waitForFunction((zoom) => (window as ObservedWindow).__routeMap!.getZoom() > zoom, previousZoom);
  await settled(page);
}

async function centerOnPriorityClient(page: Page) {
  await page.evaluate(() => {
    const map = (window as ObservedWindow).__routeMap!;
    map.setView([-5.9, -35.25], map.getZoom(), { animate: false });
  });
  await page.waitForFunction(() => {
    const center = (window as ObservedWindow).__routeMap!.getCenter();
    // Leaflet snaps the requested center to the current pixel grid.
    return Math.abs(center.lat + 5.9) < 1e-3 && Math.abs(center.lng + 35.25) < 1e-3;
  });
}

async function freehandPoints(page: Page) {
  const canvas = page.getByLabel('Clientes elegíveis no mapa');
  await expect(page.locator('.route-intelligence-canvas-wrap')).toHaveAttribute('data-drawing', 'true');
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const box = (await canvas.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return [
    { x: center.x - 55, y: center.y - 55 }, { x: center.x + 55, y: center.y - 55 },
    { x: center.x + 55, y: center.y + 55 }, { x: center.x - 55, y: center.y + 55 },
    { x: center.x - 55, y: center.y - 55 },
  ];
}

test.describe('weekly commercial route intelligence', () => {
  test.use({ serviceWorkers: 'block' });

  test('contains map, compact summary, long stops and all actions across desktop, mobile and 200% reflow', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openMap(page, true);
    await page.evaluate(() => { (window as ObservedWindow).__originalRouteMap = (window as ObservedWindow).__routeMap; });
    await centerOnPriorityClient(page);
    const original = await view(page);
    const runtimeClasses = (await page.getByLabel('Clientes elegíveis no mapa').getAttribute('class'))!
      .split(' ').filter((name) => name.startsWith('leaflet-')
        && !['leaflet-grab', 'leaflet-touch-drag', 'leaflet-touch-zoom'].includes(name));
    for (const width of [1920, 1440, 1280, 1024, 768, 390, 320, 195]) {
      // A 390 CSS-pixel viewport at browser zoom 200% has 195 CSS pixels available.
      await page.setViewportSize({ width, height: width === 195 ? 422 : 844 });
      await expect.poll(() => page.evaluate(() => {
        const map = (window as ObservedWindow).__routeMap!;
        return map.getSize().x === map.getContainer().clientWidth;
      })).toBe(true);
      const measurements = await page.evaluate(() => {
        const bounds = (element: Element) => { const box = element.getBoundingClientRect(); return {
          left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
        }; };
        const main = document.querySelector('.weekly-route-page')!;
        const map = document.querySelector('.route-intelligence-canvas')!;
        const summary = document.querySelector('.weekly-route-summary')!;
        const days = Array.from(document.querySelectorAll('.weekly-route-days > section'));
        return { overflow: document.documentElement.scrollWidth > innerWidth, main: bounds(main), map: bounds(map),
          overflowing: Array.from(document.querySelectorAll('body *')).filter((element) => {
            if (element.closest('.leaflet-pane')) return false;
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.right > innerWidth + 1;
          }).map((element) => `${element.tagName}.${element.getAttribute('class') ?? ''}`).slice(0, 12),
          summaryPosition: getComputedStyle(summary).position, summary: bounds(summary),
          days: days.map((day) => ({ ...bounds(day), name: day.getAttribute('aria-label'),
            scroll: getComputedStyle(day.querySelector('ol')!).overflowY })),
          stops: Array.from(main.querySelectorAll('.route-planner-stop-list li')).map((stop) => ({
            box: bounds(stop), buttons: Array.from(stop.querySelectorAll('button')).map(bounds),
            textClipped: Array.from(stop.querySelectorAll('strong, small, .route-planner-stop-info span'))
              .some((element) => element.scrollWidth > element.clientWidth + 1),
          })),
        };
      });
      expect(measurements.overflow, `page overflow at ${width}px: ${measurements.overflowing.join(', ')}`).toBe(false);
      expect(measurements.map.left).toBeGreaterThanOrEqual(measurements.main.left);
      expect(measurements.map.right).toBeLessThanOrEqual(measurements.main.right);
      expect(measurements.map.bottom).toBeLessThanOrEqual(measurements.summary.top);
      expect(measurements.summaryPosition).toBe('static');
      expect(measurements.days.map((day) => day.name)).toEqual(['Dia 1', 'Dia 2', 'Dia 3', 'Dia 4', 'Dia 5']);
      expect(Math.max(...measurements.days.map((day) => day.width)) - Math.min(...measurements.days.map((day) => day.width))).toBeLessThan(1);
      for (const day of measurements.days) {
        expect(day.right).toBeLessThanOrEqual(measurements.main.right);
        expect(day.scroll).toBe('visible');
      }
      for (const stop of measurements.stops) {
        expect(stop.textClipped).toBe(false);
        expect(stop.buttons).toHaveLength(5);
        for (const button of stop.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(stop.box.left);
          expect(button.right).toBeLessThanOrEqual(stop.box.right + 1);
          expect(button.bottom).toBeLessThanOrEqual(stop.box.bottom);
          expect(button.width).toBeGreaterThanOrEqual(44);
          expect(button.bottom - button.top).toBeGreaterThanOrEqual(44);
        }
      }
      if ([1440, 390, 195].includes(width)) {
        // Isolated component captures omit the shell's sticky overlay; its menu
        // stacking and access are verified separately below with normal styles.
        const style = '.management-mobile-header, .management-skip { visibility: hidden !important; }';
        await page.locator('.route-intelligence-map').screenshot({ path: testInfo.outputPath(`weekly-map-${width}px.png`), style });
        await page.locator('.weekly-route-summary').screenshot({ path: testInfo.outputPath(`weekly-summary-${width}px.png`), style });
        await page.locator('.weekly-route-days > section').first().screenshot({ path: testInfo.outputPath(`weekly-day-${width}px.png`), style });
      }
      if (width === 390 || width === 195) {
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        const menu = page.getByRole('region', { name: 'Menu da gestão' });
        await expect(menu).toBeVisible();
        expect(await menu.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const target = document.elementFromPoint(box.left + box.width / 2, Math.min(box.bottom - 1, innerHeight - 1));
          return element.contains(target);
        })).toBe(true);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => (await view(page)).zoom).toBe(original.zoom);
    const afterResize = await view(page);
    expect(Math.abs(afterResize.center[0]! - original.center[0]!)).toBeLessThan(.002);
    expect(Math.abs(afterResize.center[1]! - original.center[1]!)).toBeLessThan(.002);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByRole('button', { name: /Caneta: desenhar área/ }).click();
      for (const name of runtimeClasses) await expect(page.getByLabel('Clientes elegíveis no mapa')).toHaveClass(new RegExp(`\\b${name}\\b`));
      await page.getByRole('button', { name: /Borracha: apagar desenho/ }).click();
      for (const name of runtimeClasses) await expect(page.getByLabel('Clientes elegíveis no mapa')).toHaveClass(new RegExp(`\\b${name}\\b`));
    }
    expect(await page.evaluate(() => (window as ObservedWindow).__routeMap === (window as ObservedWindow).__originalRouteMap)).toBe(true);
    // Day order in the DOM is also keyboard order; no visual CSS reordering.
    const days = page.locator('.weekly-route-days > section');
    for (let index = 0; index < 4; index += 1) {
      await days.nth(index).getByRole('button', { name: /^Remover / }).last().focus();
      await page.keyboard.press('Tab');
      await expect(days.nth(index + 1).getByRole('button', { name: /^Descer / }).first()).toBeFocused();
    }
    await page.evaluate(axe.source);
    const accessibility = await page.evaluate(async () => {
      const engine = (window as ObservedWindow).axe!;
      return engine.run(document.querySelector('.weekly-route-page')!, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
      });
    });
    expect(accessibility.violations).toEqual([]);
  });

  test('keeps long safe popup content inside the map at 390px after zoom, with keyboard close', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMap(page);
    const marker = page.getByRole('button', { name: `Detalhes de ${longName}`, exact: true });
    await marker.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Detalhes de ${longName}`, exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText('volume recente caiu 50%');
    await expect(dialog.locator('script, img')).toHaveCount(0);
    await zoomIn(page);
    const popup = page.locator('.route-intelligence-popup');
    const popupBox = (await popup.boundingBox())!;
    const mapBox = (await page.getByLabel('Clientes elegíveis no mapa').boundingBox())!;
    expect(popupBox.x).toBeGreaterThanOrEqual(mapBox.x - 2);
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(mapBox.x + mapBox.width + 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const content = popup.locator('.leaflet-popup-content');
    expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await dialog.focus(); await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(marker).toBeFocused();
  });

  test('draws a freehand area, erases without selecting, and preserves center/zoom through filtering and selection', async ({ page }) => {
    await openMap(page);
    await zoomIn(page);
    await centerOnPriorityClient(page);
    await page.evaluate(() => { (window as ObservedWindow).__originalRouteMap = (window as ObservedWindow).__routeMap; });
    const initial = await view(page);
    await page.getByLabel('Com débito oficial de sucata', { exact: true }).check();
    await expect(page.getByText('1 clientes visíveis')).toBeVisible();
    expect(await view(page)).toEqual(initial);
    await page.getByRole('checkbox', { name: `Selecionar ${longName}`, exact: true }).check();
    expect(await view(page)).toEqual(initial);
    await page.getByRole('button', { name: 'Limpar clientes selecionados' }).click();
    await page.getByRole('button', { name: /Caneta: desenhar área/ }).click();
    let points = await freehandPoints(page);
    await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByText(/Área desenhada: 1 clientes filtrados/)).toBeVisible();
    await expect(page.getByText(/0 selecionados/)).toBeVisible();
    await page.getByRole('button', { name: /Borracha: apagar desenho/ }).click();
    await expect(page.getByText(/0 selecionados/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar área desenhada' })).toHaveCount(0);
    await page.getByRole('button', { name: /Caneta: desenhar área/ }).click();
    points = await freehandPoints(page);
    await page.mouse.move(points[0]!.x, points[0]!.y); await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Aplicar área desenhada' }).click();
    await expect(page.getByText(/1 selecionados/)).toBeVisible();
    expect(await view(page)).toEqual(initial);
    expect(await page.evaluate(() => (window as ObservedWindow).__routeMap === (window as ObservedWindow).__originalRouteMap)).toBe(true);
    await page.getByLabel('Com débito oficial de sucata', { exact: true }).uncheck();
    expect(await view(page)).toEqual(initial);
    await page.getByRole('checkbox', { name: 'Selecionar Cliente estável', exact: true }).check();
    await page.getByText('Alternativa: selecionar por centro e raio').click();
    await page.getByLabel('Latitude do centro').fill('-5.9');
    await page.getByLabel('Longitude do centro').fill('-35.25');
    await page.getByLabel('Raio (km)').fill('1');
    await page.getByRole('button', { name: 'Pré-visualizar círculo' }).click();
    await expect(page.getByText(/Prévia: 1 clientes filtrados na área/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar seleção de área' }).click();
    await expect(page.getByText(/2 selecionados/)).toBeVisible();
    await page.getByRole('button', { name: 'Pré-visualizar círculo' }).click();
    await page.getByRole('button', { name: 'Aplicar seleção' }).click();
    await expect(page.getByText(/2 selecionados/)).toBeVisible();
  });

  test('draws and applies a touch area and restores navigation after preview', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMap(page);
    await page.getByLabel('Com débito oficial de sucata', { exact: true }).check();
    await centerOnPriorityClient(page);
    await page.getByRole('button', { name: /Caneta: desenhar área/ }).click();
    const points = await freehandPoints(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...points[0]!, id: 1 }] });
    for (const point of points.slice(1)) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByText(/Área desenhada: 1 clientes filtrados/)).toBeVisible();
    expect(await page.evaluate(() => (window as ObservedWindow).__routeMap!.dragging.enabled())).toBe(true);
    expect(await page.evaluate(() => (window as ObservedWindow).__routeMap!.touchZoom.enabled())).toBe(true);
    await page.getByRole('button', { name: 'Aplicar área desenhada' }).click();
    await expect(page.getByText(/1 selecionados/)).toBeVisible();
    await cdp.detach();
  });
});
