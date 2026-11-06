import { expect, test, type Page } from '@playwright/test';
import { syntheticClientSales } from '../../apps/web/src/features/clients/client-sales-fixture';

const id = (value: number) => `40000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const clients = [1, 2].map((value) => ({ id: id(value), externalReference: `CLI-${value}`, name: value === 1 ? 'Loja Centro' : 'Loja Norte',
  address: 'Rua sintética, 10', portfolioReference: 'Carteira sintética', latitude: null, longitude: null }));

type DeferredClientList = {
  hold: boolean;
  pending: boolean;
  consumed: boolean;
  release: (() => Promise<void>) | null;
};

async function setup(page: Page, manager = false, canReadSales = true) {
  const reads: URL[] = []; const mutations: string[] = []; const signals: URL[] = [];
  let failure = 0; let noHistory = false; let catalogUnavailable = false; let catalogPublished = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (success: PositionCallback) => success({
        coords: { latitude: -5.81, longitude: -35.21, accuracy: 12, altitude: null,
          altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now(),
      } as GeolocationPosition),
    } });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/me/route-location' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { latitude: number; longitude: number; accuracyM: number; capturedAt: string };
      return route.fulfill({ json: { kind: 'current_gps', sellerId: id(10), locationId: id(80),
        capturedBy: id(10), version: 1, latitude: body.latitude, longitude: body.longitude,
        accuracyM: body.accuracyM, capturedAt: body.capturedAt } });
    }
    if (route.request().method() !== 'GET') { mutations.push(url.pathname); return route.fulfill({ status: 500, json: {} }); }
    if (url.pathname === '/api/v1/me') return route.fulfill({ json: {
      id: id(10), displayName: 'Pessoa sintética', roles: [manager ? 'manager' : 'seller'], status: 'active', scopeIds: [id(10)],
      capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'route.read_scoped', 'route.plan_scoped', 'clients.read',
        ...(manager ? ['clients.manage', 'clients.import'] : []),
        ...(canReadSales ? ['sales.read_client'] : [])],
    } });
    if (url.pathname === '/api/v1/clients/sellers') return route.fulfill({ json: { schemaVersion: 1, sellers: [{ id: id(10), displayName: 'Vendedor sintético', email: 'seller@example.invalid' }] } });
    if (url.pathname === '/api/v1/clients') return route.fulfill({ json: { schemaVersion: 1, query: '', clients: clients.map((client) => ({ ...client,
      schemaVersion: 1, sellerId: id(10), sellerEmail: 'seller@example.invalid', status: 'active', version: 1 })),
      pagination: { page: 1, pageSize: 25, totalCount: 2, totalPages: 1, hasPrevious: false, hasNext: false } } });
    if (url.pathname === '/api/v1/routes') return route.fulfill({ json: { schemaVersion: 1, availability: 'empty', sellerId: id(10), serviceDate: url.searchParams.get('serviceDate') } });
    if (url.pathname.endsWith('/today')) return route.fulfill({ json: { schemaVersion: 2, availability: 'available', route: {
      schemaVersion: 2, routeId: id(20), routeVersionId: id(21), versionNumber: 1, serviceDate: '2026-11-03', status: 'published',
      publishedAt: '2026-11-03T09:00:00Z', executionVersion: 1, seller: { id: id(10), displayName: 'Pessoa sintética' },
      stops: clients.map((client, index) => ({ client, routeVersionStopId: id(30 + index), plannedOrder: index + 1, executionOrder: index + 1,
        priority: 0, status: 'pending', executionVersion: 1 })),
    } } });
    if (url.pathname === '/api/v1/management/sales-signals') {
      signals.push(url);
      const data = syntheticClientSales();
      const context = { schemaVersion: 1, generationId: data.salesGenerationId, fetchedAt: data.fetchedAt,
        publishedAt: data.publishedAt, observedFrom: data.observedFrom, observedThrough: data.observedThrough,
        asOfDate: data.asOfDate, coverageStatus: data.coverageStatus, coverageLimited: data.coverageLimited,
        stale: data.stale, staleAfterHours: data.staleAfterHours, windows: data.windows };
      return route.fulfill({ json: { ...context, sellerId: id(10), serviceDate: url.searchParams.get('serviceDate'),
        signals: clients.map((client, index) => ({ client: { id: client.id, name: client.name }, metrics: { ...data.metrics, daysSinceLastPurchase: index ? 60 : 33 } })) } });
    }
    if (url.pathname.endsWith('/sales')) {
      reads.push(url);
      if (failure) return route.fulfill({ status: failure, json: { error: { code: failure === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'FORBIDDEN', details: { reason: 'no_published_generation' } } } });
      if (catalogPublished && url.searchParams.get('catalogState') === 'catalog_unavailable') {
        return route.fulfill({ status: 409, json: { error: { code: 'VERSION_CONFLICT' } } });
      }
      const data = syntheticClientSales(url.pathname.split('/').at(-2));
      const client = clients.find((item) => item.id === data.client.id)!;
      data.client.name = client.name;
      data.history.page = Number(url.searchParams.get('historyPage') ?? '1');
      if (noHistory) {
        data.dataState = 'no_history'; data.history.rows = []; data.history.totalCount = 0; data.history.totalPages = 0; data.topProducts = [];
        data.chart = data.chart.map((month) => ({ ...month, netVolume: 0, salesVolume: 0, returnVolume: 0, hasRecords: false }));
        data.metrics = { ...data.metrics, lastPurchaseDate: null, daysSinceLastPurchase: null, periodicityDays: null,
          positivePurchaseDateCount: 0, intervalCount: 0, averageMonthlyVolume: 0, netVolume6: 0, cycleState: 'no_history' };
      }
      if (catalogUnavailable) {
        data.catalog = { status: 'catalog_unavailable' };
        data.opportunities = { availability: 'catalog_unavailable' };
      }
      return route.fulfill({ json: data });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  return { reads, mutations, signals, fail: (status: number) => { failure = status; }, empty: () => { noHistory = true; },
    withoutCatalog: () => { catalogUnavailable = true; }, publishCatalog: () => { catalogPublished = true; } };
}

test.describe('online client sales CRM', () => {
  test.use({ serviceWorkers: 'block' });
  test('opens the CRM directly from the manager client list and preserves search and keyboard focus', async ({ page }) => {
    const state = await setup(page, true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/management/clients');
    const search = page.getByLabel('Pesquisar clientes');
    await expect(search).toBeVisible();
    const searchPosition = await search.boundingBox();
    const importPosition = await page.getByRole('heading', { name: 'Importar planilha oficial' }).boundingBox();
    expect(searchPosition!.y).toBeLessThan(importPosition!.y);
    await search.fill('Loja Centro');
    const trigger = page.getByRole('button', { name: 'Ver mini CRM de Loja Centro', exact: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Loja Centro' });
    await expect(dialog.getByText('33 dias', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('table')).toContainText('-5');
    await expect(dialog.getByRole('heading', { name: 'Top 10 produtos por volume líquido positivo' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Histórico de compras · 12 meses' })).toBeVisible();
    await expect(dialog).toContainText('Catálogo oficial com 157 produtos');
    expect(state.reads[0]!.pathname).toBe(`/api/v1/clients/${clients[0]!.id}/sales`);
    expect(state.mutations).toHaveLength(0);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(search).toHaveValue('Loja Centro');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    state.fail(503);
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Histórico ainda não disponibilizado');
    await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByRole('heading', { name: 'Loja Centro' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Editar cliente', exact: true }).first()).toBeEnabled();
  });

  test('does not offer client CRM without the sales capability and clears the list on session change', async ({ page }) => {
    const state = await setup(page, true, false);
    await page.goto('/management/clients');
    await expect(page.getByRole('heading', { name: 'Loja Centro' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ver mini CRM de/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Consultar compras de/ })).toHaveCount(0);
    expect(state.reads).toHaveLength(0);
    await page.evaluate(() => { const channel = new BroadcastChannel('cirne-session'); channel.postMessage('changed'); channel.close(); });
    await expect(page.getByText('Seu acesso mudou. Entre novamente para consultar os clientes.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Loja Centro' })).toHaveCount(0);
  });

  for (const operation of ['search failure', 'initial retry success'] as const) {
    test(`preserves the revocation notice after a delayed client ${operation}`, async ({ page }) => {
      await setup(page, true);
      await page.addInitScript((operation) => {
        const originalFetch = window.fetch.bind(window);
        const state: DeferredClientList = { hold: false, pending: false, consumed: false, release: null };
        Reflect.set(window, '__deferredClientList', state);
        window.fetch = async (input, options) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
          if (url.pathname !== '/api/v1/clients') return originalFetch(input, options);
          if (!state.hold) {
            return operation === 'initial retry success'
              ? new Response('{}', { status: 503 }) : originalFetch(input, options);
          }
          state.pending = true;
          return new Promise<Response>((resolve) => {
            state.release = async () => {
              const response = operation === 'search failure'
                ? new Response('{}', { status: 503 }) : await originalFetch(input, options);
              const readJson = response.json.bind(response);
              response.json = async () => {
                const value: unknown = await readJson();
                state.consumed = true;
                return value;
              };
              resolve(response);
            };
          });
        };
      }, operation);
      await page.goto('/management/clients');
      if (operation === 'search failure') {
        await expect(page.getByRole('heading', { name: 'Loja Centro' })).toBeVisible();
        await page.getByLabel('Pesquisar clientes').fill('Loja Centro');
      } else {
        await expect(page.getByRole('button', { name: 'Tentar carregar clientes novamente' })).toBeVisible();
      }
      await page.evaluate(() => { (Reflect.get(window, '__deferredClientList') as DeferredClientList).hold = true; });
      await page.getByRole('button', {
        name: operation === 'search failure' ? 'Buscar clientes' : 'Tentar carregar clientes novamente', exact: true,
      }).click();
      await expect.poll(() => page.evaluate(() =>
        (Reflect.get(window, '__deferredClientList') as DeferredClientList).pending)).toBe(true);
      await page.evaluate(() => {
        const channel = new BroadcastChannel('cirne-session');
        channel.postMessage('changed');
        channel.close();
      });
      const revoked = page.getByRole('status').filter({ hasText: 'Seu acesso mudou. Entre novamente para consultar os clientes.' });
      await expect(revoked).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Loja Centro' })).toHaveCount(0);

      await page.evaluate(async () => {
        const state = Reflect.get(window, '__deferredClientList') as DeferredClientList;
        if (!state.release) throw new Error('Expected a pending synthetic client request.');
        await state.release();
      });
      await expect.poll(() => page.evaluate(() =>
        (Reflect.get(window, '__deferredClientList') as DeferredClientList).consumed)).toBe(true);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(revoked).toBeVisible();
      await expect(page.getByText('Clientes carregados.', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Não foi possível confirmar a operação. Seus dados continuam nesta tela.', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Loja Centro' })).toHaveCount(0);
      await expect(page.getByRole('search')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Tentar carregar clientes novamente' })).toHaveCount(0);
    });
  }

  test('renders a plain client heading when the seller cannot read sales', async ({ page }) => {
    await setup(page, false, false);
    await page.goto('/route');
    await expect(page.getByRole('heading', { name: 'Loja Centro' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Consultar compras de Loja Centro' })).toHaveCount(0);
  });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    test(`preserves seller draft, supports keyboard and signed accessible chart at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport); const state = await setup(page);
      await page.goto('/route');
      await page.getByRole('button', { name: 'Reordenar' }).click();
      await page.getByRole('button', { name: 'Descer Loja Centro' }).click();
      const trigger = page.getByRole('button', { name: 'Consultar compras de Loja Centro' });
      await trigger.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Loja Centro' });
      await expect(dialog.getByText('33 dias', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('table')).toContainText('-5');
      await expect(dialog.getByText('Mês atual: Parcial.', { exact: false })).toHaveCount(1);
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const close = dialog.getByRole('button', { name: 'Fechar', exact: true });
      const size = await close.boundingBox(); expect(size!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath(`crm-${viewport.width}.png`) });
      await dialog.getByRole('table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`crm-chart-${viewport.width}.png`) });
      await dialog.getByRole('heading', { name: 'Produtos sem compra registrada no histórico disponível' }).scrollIntoViewIfNeeded();
      await expect(dialog).toContainText('Catálogo oficial com 157 produtos');
      await expect(dialog).toContainText('Produto exclusivo do catálogo oficial');
      await page.screenshot({ path: testInfo.outputPath(`crm-catalog-${viewport.width}.png`) });
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
      await expect(page.getByRole('button', { name: 'Salvar ordem' })).toBeVisible();
      await expect(page.locator('.seller-stop-card').first()).toContainText('Loja Norte');
      expect(state.mutations).toHaveLength(0);
    });
  }

  test('pins pages with the complete context and requires explicit reload on conflict', async ({ page }) => {
    const state = await setup(page); await page.goto('/route');
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('navigation', { name: 'Paginação de histórico', exact: true }).getByRole('button', { name: 'Próxima' }).click();
    await expect(dialog.getByRole('navigation', { name: 'Paginação de histórico', exact: true })).toContainText('Página 2 de 2');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const query = state.reads.at(-1)!.searchParams;
    const synthetic = syntheticClientSales();
    expect(query.get('salesGenerationId')).toBe(synthetic.salesGenerationId);
    expect(query.get('catalogState')).toBe(synthetic.catalog.status);
    expect(query.get('catalogGenerationId')).toBe(synthetic.catalog.status === 'available'
      ? synthetic.catalog.generationId : null);
    expect(query.get('asOfDate')).toBe('2026-11-03'); expect(query.get('clientVersion')).toBe('1');
    state.fail(409);
    await dialog.getByRole('navigation', { name: 'Paginação de histórico', exact: true }).getByRole('button', { name: 'Anterior' }).click();
    await expect(dialog.getByRole('alert')).toContainText('referência do histórico mudou');
    await expect(dialog.getByRole('table')).toHaveCount(0);
    const count = state.reads.length; await page.waitForTimeout(100); expect(state.reads).toHaveLength(count);
    state.fail(0); await dialog.getByRole('button', { name: 'Atualizar consulta' }).click();
    await expect(dialog.getByRole('table')).toBeVisible(); expect(state.reads.at(-1)!.searchParams.has('salesGenerationId')).toBe(false);
  });

  test('pins catalog absence and rejects adopting the first catalog between history pages', async ({ page }) => {
    const state = await setup(page); state.withoutCatalog(); await page.goto('/route');
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Catálogo oficial ainda não disponibilizado');
    state.publishCatalog();
    await dialog.getByRole('navigation', { name: 'Paginação de histórico', exact: true })
      .getByRole('button', { name: 'Próxima' }).click();
    const query = state.reads.at(-1)!.searchParams;
    expect(query.get('catalogState')).toBe('catalog_unavailable');
    expect(query.has('catalogGenerationId')).toBe(false);
    await expect(dialog.getByRole('alert')).toContainText('referência do histórico mudou');
  });

  test('keeps no history, first generation, offline and revoked access distinct', async ({ page, context }) => {
    const state = await setup(page); state.empty(); await page.goto('/route');
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    let dialog = page.getByRole('dialog'); await expect(dialog.getByText(/Sem histórico disponível para este cliente/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar' }).click(); state.fail(503);
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click(); dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toContainText('Histórico ainda não disponibilizado');
    await context.setOffline(true); await expect(dialog.getByText(/Histórico comercial disponível somente online/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar' }).click(); await expect(page.getByRole('heading', { name: 'Minha rota de hoje.' })).toBeVisible();
    await context.setOffline(false); state.fail(0);
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click(); await expect(page.getByRole('dialog').getByRole('table')).toBeVisible();
    state.fail(403);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.getByRole('dialog').getByRole('table')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('autorização');
    await expect(page.getByRole('dialog').getByRole('table')).toHaveCount(0);
  });

  test('queries only visible planner clients, sorts the page and preserves composition and priority', async ({ page }, testInfo) => {
    const state = await setup(page, true); await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/management/routes');
    await expect(page.getByLabel('Ordenar esta página')).toBeEnabled();
    expect(state.signals[0]!.searchParams.get('clientIds')).toBe(clients.map((client) => client.id).join(','));
    await page.getByRole('button', { name: 'Adicionar', exact: true }).first().click();
    await page.getByLabel('Prioridade de Loja Centro').selectOption('4');
    await page.getByLabel('Ordenar esta página').selectOption('recency');
    await expect(page.locator('.route-planner-client-list li').first()).toContainText('Loja Norte');
    await expect(page.locator('.route-planner-stop-list li')).toContainText('Loja Centro');
    await page.locator('.route-planner-stop-list').getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    await expect(page.getByRole('dialog').getByRole('table')).toBeVisible();
    expect(state.reads[0]!.searchParams.has('salesGenerationId')).toBe(false);
    await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByLabel('Prioridade de Loja Centro')).toHaveValue('4');
    expect(state.mutations).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('crm-planner-desktop.png'), fullPage: true });
  });

  test('emulates reflow equivalent to 200 percent with keyboard focus contained in the dialog', async ({ page }, testInfo) => {
    await setup(page);
    // A 1280×1000 display at 200% exposes a 640×500 CSS viewport. Unlike CSS zoom,
    // this exercises responsive breakpoints and viewport units as browser zoom does.
    await page.setViewportSize({ width: 640, height: 500 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 500, deviceScaleFactor: 2, mobile: false });
    await page.goto('/route');
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('table')).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await dialog.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('crm-200-percent.png') });
  });

  test('discards delayed signals after the planning date changes', async ({ page }) => {
    await setup(page, true);
    let release: (() => void) | undefined;
    let signalRequestCount = 0;
    let delayedResponseFinished = false;
    await page.route('**/api/v1/management/sales-signals?*', async (route) => {
      signalRequestCount += 1;
      if (signalRequestCount !== 1) return route.fallback();
      await new Promise<void>((resolve) => { release = resolve; });
      const data = syntheticClientSales();
      const signalContext = { schemaVersion: 1, generationId: data.salesGenerationId, fetchedAt: data.fetchedAt,
        publishedAt: data.publishedAt, observedFrom: data.observedFrom, observedThrough: data.observedThrough,
        asOfDate: '2020-01-01', coverageStatus: data.coverageStatus, coverageLimited: data.coverageLimited,
        stale: data.stale, staleAfterHours: data.staleAfterHours, windows: data.windows };
      await route.fulfill({ json: { ...signalContext, sellerId: id(10),
        serviceDate: new URL(route.request().url()).searchParams.get('serviceDate'),
        signals: clients.map((client) => ({ client: { id: client.id, name: client.name }, metrics: { ...data.metrics, daysSinceLastPurchase: 9999 } })) } }).catch(() => undefined);
      delayedResponseFinished = true;
    });
    await page.goto('/management/routes'); await expect.poll(() => signalRequestCount).toBe(1);
    await page.getByLabel('Data da rota').fill('2026-11-05');
    await expect(page.getByLabel('Ordenar esta página')).toBeEnabled();
    await expect(page.locator('.client-sales-planner-controls')).toContainText('03/11/2026');
    release!();
    await expect.poll(() => delayedResponseFinished).toBe(true);
    await expect(page.locator('.client-sales-signal').first()).toContainText('33 dias');
    await expect(page.locator('.client-sales-planner-controls')).not.toContainText('01/01/2020');
    await expect(page.getByText(/9999 dias/)).toHaveCount(0);
  });

  test('clears visible dialog and signals on cross-tab identity revocation', async ({ page }) => {
    await setup(page, true); await page.goto('/management/routes');
    await expect(page.getByLabel('Ordenar esta página')).toBeEnabled();
    await page.getByRole('button', { name: 'Consultar compras de Loja Centro' }).click();
    await expect(page.getByRole('dialog').getByRole('table')).toBeVisible();
    await page.evaluate(() => { const channel = new BroadcastChannel('cirne-session'); channel.postMessage('changed'); channel.close(); });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.client-sales-signal')).toHaveCount(0);
    await expect(page.getByLabel('Ordenar esta página')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Consultar compras de Loja Centro' })).toBeDisabled();
  });
});
