import { expect, test, type Page } from '@playwright/test';
import type { CanonicalRoute, MeResponse } from '@cirne/contracts';

const sellerId = '33333333-3333-4333-8333-333333333331';
const routeStopId = '33333333-3333-4333-8333-333333333334';
const canonicalVisitId = '33333333-3333-4333-8333-333333333399';
const competitorId = 'c1000000-0000-4000-8000-000000000001';
const technologyId = 'c1000000-0000-4000-8000-000000000002';
const conditionId = 'c1000000-0000-4000-8000-000000000003';
const unavailableReasonId = 'c1000000-0000-4000-8000-000000000004';
const identity: MeResponse = {
  id: sellerId,
  displayName: 'Vendedor sintético de visitas',
  roles: ['seller'],
  capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'sync.write_self', 'visit.start_self'],
  scopeIds: [sellerId],
  status: 'active',
};
const route: CanonicalRoute = {
  schemaVersion: 3,
  routeId: '33333333-3333-4333-8333-333333333332',
  routeVersionId: '33333333-3333-4333-8333-333333333333',
  versionNumber: 1,
  serviceDate: '2026-09-17',
  status: 'published',
  publishedAt: '2026-09-17T09:00:00.000Z',
  executionVersion: 1,
  seller: { id: sellerId, displayName: identity.displayName },
  compositionChange: null,
  stops: [{
    routeVersionStopId: routeStopId,
    plannedOrder: 1,
    executionOrder: 1,
    priority: 1,
    status: 'pending',
    executionVersion: 1,
    client: {
      id: '33333333-3333-4333-8333-333333333335',
      externalReference: 'VISIT-01',
      name: 'Cliente sintético da visita',
      address: 'Rua do Teste, 31 — Recife, PE',
      latitude: null,
      longitude: null,
      portfolioReference: null,
    },
  }],
};

const revisedRoute: CanonicalRoute = {
  ...route,
  routeVersionId: '33333333-3333-4333-8333-333333333343',
  versionNumber: 2,
  executionVersion: 2,
  compositionChange: {
    reason: 'Cliente retirado durante atendimento offline', previousVersionNumber: 1,
    removed: [{ id: route.stops[0]!.client.id, name: route.stops[0]!.client.name }],
    added: [{ id: '33333333-3333-4333-8333-333333333345', name: 'Novo cliente da rota' }],
  },
  stops: [{
    ...route.stops[0]!, routeVersionStopId: '33333333-3333-4333-8333-333333333344',
    client: { ...route.stops[0]!.client, id: '33333333-3333-4333-8333-333333333345', name: 'Novo cliente da rota' },
  }],
};

const priceParameters = {
  schemaVersion: 1 as const,
  parameterSetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  version: 1,
  validFrom: '2026-09-17T00:00:00.000Z',
  values: {
    competitors: [{ id: competitorId, category: 'competitor' as const, code: 'synthetic_competitor', label: 'Concorrente Sintético', sortOrder: 1 }],
    technologies: [{ id: technologyId, category: 'competitor_price_technology' as const, code: 'synthetic_technology', label: 'Tecnologia Sintética', sortOrder: 1 }],
    conditions: [{ id: conditionId, category: 'competitor_price_condition' as const, code: 'synthetic_condition', label: 'Condição Sintética', sortOrder: 1 }],
    unavailableReasons: [{ id: unavailableReasonId, category: 'competitor_price_unavailable_reason' as const, code: 'synthetic_unavailable', label: 'Motivo Sintético', sortOrder: 1 }],
  },
};

async function mockVisitSeller(
  page: Page,
  failure: 'none' | 'lost-response' | 'stock-lost-response' | 'conflict' = 'none',
  catalog: 'complete' | 'empty' = 'complete',
) {
  await page.addInitScript(({ identityFixture, routeFixture, revisedFixture, visitId, failureMode, parameterFixture, catalogMode }) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      if (url.pathname === '/api/v1/me') return json(identityFixture);
      if (url.pathname === '/api/v1/me/routes/today') {
        return json({ schemaVersion: 3, availability: 'available',
          route: sessionStorage.getItem('visit-route-revised') === 'true' ? revisedFixture : routeFixture });
      }
      if (url.pathname === '/api/v1/parameter-sets/current') {
        return json(catalogMode === 'complete' ? parameterFixture : {
          ...parameterFixture,
          values: { competitors: [], technologies: [], conditions: [], unavailableReasons: [] },
        });
      }
      if (url.pathname === '/api/v1/sync/batches') {
        const batch = JSON.parse(String(init?.body)) as {
          events: Array<{ eventId: string; operation: string }>;
        };
        const count = Number(sessionStorage.getItem('visit-sync-batches') ?? '0') + 1;
        sessionStorage.setItem('visit-sync-batches', String(count));
        const body = String(init?.body);
        if (count === 1) sessionStorage.setItem('first-visit-batch', body);
        else sessionStorage.setItem('same-visit-batch', String(body === sessionStorage.getItem('first-visit-batch')));
        const stockBatch = batch.events.some(({ operation }) => operation === 'visit.stock.saved.v1');
        if (stockBatch) {
          const stockCount = Number(sessionStorage.getItem('visit-stock-sync-batches') ?? '0') + 1;
          sessionStorage.setItem('visit-stock-sync-batches', String(stockCount));
          if (stockCount === 1) sessionStorage.setItem('first-visit-stock-batch', body);
          else sessionStorage.setItem(
            'same-visit-stock-batch',
            String(body === sessionStorage.getItem('first-visit-stock-batch')),
          );
          if (failureMode === 'stock-lost-response' && stockCount === 1) {
            throw new TypeError('Synthetic stock response lost');
          }
        }
        if (failureMode === 'lost-response' && count === 1) throw new TypeError('Synthetic response lost');
        if (failureMode === 'conflict') return json({
          requestId: '33333333-3333-4333-8333-333333333398',
          results: batch.events.map(({ eventId }) => ({ eventId, status: 'rejected', error: {
            code: 'IDEMPOTENCY_KEY_REUSED', message: 'Conflito sintético', recoverable: false,
          } })),
        });
        return json({
          requestId: '33333333-3333-4333-8333-333333333398',
          results: batch.events.map(({ eventId }) => ({
            eventId,
            status: 'confirmed',
            canonicalId: visitId,
            confirmedAt: '2026-09-17T12:01:01.000Z',
            parameterSetId: parameterFixture.parameterSetId,
          })),
        });
      }
      return originalFetch(input, init);
    };
  }, {
    identityFixture: identity,
    routeFixture: route,
    revisedFixture: revisedRoute,
    visitId: canonicalVisitId,
    failureMode: failure,
    parameterFixture: priceParameters,
    catalogMode: catalog,
  });
}

async function offlineCounts(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const read = (storeName: string) => new Promise<unknown[]>((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [drafts, events] = await Promise.all([read('visitDrafts'), read('outboxEvents')]);
    database.close();
    return { drafts, events };
  });
}

test('starts online, confirms once and reopens the same visit after an offline hard refresh', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page).toHaveURL(/\/visit\/[0-9a-f-]+\?step=start$/i);
  const committed = await offlineCounts(page);
  expect(committed.drafts).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Cliente sintético da visita.' })).toBeVisible();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  const visitUrl = page.url();
  expect(await page.evaluate(() => sessionStorage.getItem('visit-sync-batches'))).toBe('1');
  const synchronized = await offlineCounts(page);
  expect(synchronized.events).toHaveLength(0);
  expect(synchronized.drafts).toMatchObject([{
    routeVersionStopId: routeStopId,
    canonicalVisitId,
    persistenceState: 'synced',
  }]);

  await context.setOffline(true);
  await page.goto(visitUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Cliente sintético da visita.' })).toBeVisible();
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Continuar visita' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  expect((await offlineCounts(page)).drafts).toHaveLength(1);
});

test('saves zero stock offline, restores it after hard refresh and confirms it on reconnection', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await expect(page).toHaveURL(/\?step=stock$/);
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('7');
  await page.getByLabel('Observação (opcional)').fill('Conferido no depósito');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect(page.getByText('1 de 4 etapas preenchidas')).toBeVisible();
  await expect(page.getByText(/Heliar:/)).toContainText('0');
  const saved = await offlineCounts(page);
  expect(saved.events).toMatchObject([{ operation: 'visit.stock.saved.v1', sequence: 2 }]);
  expect(saved.drafts).toMatchObject([{
    currentStep: 'prices',
    stock: { heliarQuantity: 0, mouraQuantity: 7, observation: 'Conferido no depósito', persistenceState: 'saved_on_device' },
  }]);

  const pricesUrl = page.url();
  await page.goto(pricesUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('1 de 4 etapas preenchidas')).toBeVisible();
  await page.getByRole('button', { name: 'Editar estoque' }).click();
  await expect(page.getByLabel('Quantidade observada — Heliar')).toHaveValue('0');
  await expect(page.getByLabel('Quantidade observada — Moura')).toHaveValue('7');
  await expect(page.getByLabel('Observação (opcional)')).toHaveValue('Conferido no depósito');

  await context.setOffline(false);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  const synchronized = await offlineCounts(page);
  expect(synchronized.drafts).toMatchObject([{
    stock: { heliarQuantity: 0, mouraQuantity: 7, persistenceState: 'synced' },
    lastConfirmedSequence: 2,
  }]);
  await page.goto('/route');
  await page.getByRole('button', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect(page.getByRole('heading', { name: 'Salvo no aparelho' })).toBeVisible();
});

test('does not claim stock success when prices is opened before a durable stock commit', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.goto(page.url().replace('step=start', 'step=prices'));
  await expect(page).toHaveURL(/\?step=stock$/);
  await expect(page.getByRole('heading', { name: 'Estoque observado' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salvo no aparelho' })).toHaveCount(0);
});

test('keeps stock validation and step transitions usable by keyboard on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  const entry = page.getByRole('button', { name: 'Preencher estoque' });
  await entry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Estoque observado' })).toBeFocused();
  const heliar = page.getByLabel('Quantidade observada — Heliar');
  const moura = page.getByLabel('Quantidade observada — Moura');
  const observation = page.getByLabel('Observação (opcional)');
  const submit = page.getByRole('button', { name: 'Salvar estoque e continuar' });
  for (const control of [heliar, moura, observation, submit]) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    const box = await control.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Enter');
  await expect(heliar).toBeFocused();
  await expect(heliar).toHaveAttribute('aria-describedby', 'stock-heliar-error');
  await expect(moura).toHaveAttribute('aria-describedby', 'stock-moura-error');
  await page.screenshot({ path: testInfo.outputPath('stock-mobile-errors.png'), fullPage: true });
  await page.keyboard.type('0');
  await page.keyboard.press('Tab');
  await page.keyboard.type('2');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Conferido por teclado');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Preços da concorrência' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Editar estoque' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Estoque observado' })).toBeFocused();
  await expect(heliar).toHaveValue('0');
  await expect(observation).toHaveValue('Conferido por teclado');
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const visitStatus = page.getByRole('region', { name: 'Início da visita' }).locator('strong');
  expect(await visitStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('stock-mobile-320.png'), fullPage: true });
});

test('validates empty, negative and decimal stock quantities without advancing', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.getByRole('button', { name: 'Preencher estoque' }).click();

  const heliar = page.getByLabel('Quantidade observada — Heliar');
  const moura = page.getByLabel('Quantidade observada — Moura');
  await expect(page.getByText('ETAPA 1 DE 4')).toHaveCount(0);
  await heliar.fill('');
  await moura.fill('-1');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page.locator('#stock-heliar-error')).toBeVisible();
  await expect(page.locator('#stock-moura-error')).toBeVisible();
  await expect(page).toHaveURL(/\?step=stock$/);

  await heliar.fill('1.5');
  await moura.fill('0');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page.locator('#stock-heliar-error')).toBeVisible();
  await expect(page).toHaveURL(/\?step=stock$/);
  expect((await offlineCounts(page)).events).toHaveLength(0);
});

test('keeps stock values on screen when the atomic local commit fails', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('4');
  await page.getByLabel('Observação (opcional)').fill('Não perder este texto');
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function failStockOutboxOnce(value: unknown, key?: IDBValidKey) {
      if (this.name === 'outboxEvents') {
        IDBObjectStore.prototype.add = originalAdd;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    };
  });
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page).toHaveURL(/\?step=stock$/);
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText(
    'Não foi possível salvar no aparelho',
  );
  await expect(page.getByLabel('Quantidade observada — Heliar')).toHaveValue('0');
  await expect(page.getByLabel('Quantidade observada — Moura')).toHaveValue('4');
  await expect(page.getByLabel('Observação (opcional)')).toHaveValue('Não perder este texto');
  const state = await offlineCounts(page);
  expect(state.events).toHaveLength(0);
  expect(state.drafts).toMatchObject([{ currentStep: 'start' }]);
  expect(state.drafts[0]).not.toHaveProperty('stock');
});

test('saves repeatable competitor prices offline, restores them and confirms them on reconnection', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('2');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Preços da concorrência' })).toBeFocused();

  await page.getByLabel('Marca ou concorrente').selectOption(competitorId);
  await page.getByLabel('Modelo ou amperagem').fill('60 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço em BRL').fill('399,90');
  await page.getByLabel('Condição').selectOption(conditionId);
  await page.getByLabel('Observação da cotação (opcional)').fill('Primeira cotação sintética');
  await expect(page.getByLabel('Observação da cotação (opcional)'))
    .toHaveAttribute('aria-describedby', /-hint/);
  await page.getByRole('button', { name: 'Adicionar outra cotação' }).click();
  await expect(page.getByLabel('Marca ou concorrente').nth(1)).toBeFocused();
  await page.getByLabel('Marca ou concorrente').nth(1).selectOption(competitorId);
  await page.getByLabel('Modelo ou amperagem').nth(1).fill('70 Ah');
  await page.getByLabel('Tecnologia').nth(1).selectOption(technologyId);
  await page.getByLabel('Preço em BRL').nth(1).fill('459.50');
  await page.getByLabel('Condição').nth(1).selectOption(conditionId);
  await page.getByRole('button', { name: 'Adicionar outra cotação' }).click();
  await page.getByRole('button', { name: 'Remover cotação 3' }).click();
  await expect(page.getByRole('button', { name: 'Adicionar outra cotação' })).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Cotação removida. 2 restante(s).' }))
    .toHaveText('Cotação removida. 2 restante(s).');
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();

  await expect(page).toHaveURL(/\?step=actions$/);
  await expect(page.getByRole('heading', { name: 'Salvos no aparelho' })).toBeFocused();
  await expect(page.getByText('2 de 4 etapas preenchidas')).toBeVisible();
  const saved = await offlineCounts(page);
  expect(saved.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'visit.stock.saved.v1', sequence: 2 }),
    expect.objectContaining({ operation: 'visit.prices.saved.v1', sequence: 3 }),
  ]));
  expect(saved.drafts).toMatchObject([{
    currentStep: 'actions',
    prices: { availability: 'available', quotations: [{ priceBrl: '399.90' }, { priceBrl: '459.50' }] },
  }]);

  const actionsUrl = page.url();
  await page.goto(actionsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('2 cotação(ões) registrada(s).')).toBeVisible();
  await page.getByRole('button', { name: 'Editar preços' }).click();
  await expect(page.getByLabel('Modelo ou amperagem').nth(0)).toHaveValue('60 Ah');
  await expect(page.getByLabel('Modelo ou amperagem').nth(1)).toHaveValue('70 Ah');
  await context.setOffline(false);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    prices: { availability: 'available', persistenceState: 'synced' },
    lastConfirmedSequence: 3,
  }]);
});

test('rejects a non-positive price and accepts explicit unavailability with a published reason', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('0');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();

  await page.getByLabel('Marca ou concorrente').selectOption(competitorId);
  await page.getByLabel('Modelo ou amperagem').fill('50 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço em BRL').fill('0');
  await page.getByLabel('Condição').selectOption(conditionId);
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await expect(page.getByText('Informe um preço maior que zero, sem arredondamento. Exemplo: 399,90.')).toBeVisible();
  await expect(page.getByLabel('Preço em BRL')).toBeFocused();
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await expect(page.getByLabel('Preço em BRL')).toBeFocused();
  await expect(page).toHaveURL(/\?step=prices$/);

  await page.getByLabel('Preço não disponível').check();
  await page.getByLabel('Motivo da indisponibilidade').selectOption(unavailableReasonId);
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await expect(page).toHaveURL(/\?step=actions$/);
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    prices: { availability: 'unavailable', unavailableReasonId },
  }]);
});

test('does not invent a prices response when the approved catalog is unavailable', async ({ page, context }) => {
  await mockVisitSeller(page, 'none', 'empty');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('0');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page.getByText('Configuração comercial indisponível.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar preços e continuar' })).toBeDisabled();
  const state = await offlineCounts(page);
  expect(state.events).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'visit.prices.saved.v1' }),
  ]));
  expect(state.drafts[0]).not.toHaveProperty('prices');
});

test('keeps competitor price values on screen when the atomic local commit fails', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('1');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect.poll(() => page.evaluate(
    () => Number(sessionStorage.getItem('visit-stock-sync-batches') ?? '0'),
  )).toBeGreaterThan(0);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  await context.setOffline(true);
  await page.getByLabel('Marca ou concorrente').selectOption(competitorId);
  await page.getByLabel('Modelo ou amperagem').fill('80 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço em BRL').fill('520.00');
  await page.getByLabel('Condição').selectOption(conditionId);
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function failPricesOutboxOnce(value: unknown, key?: IDBValidKey) {
      if (this.name === 'outboxEvents') {
        IDBObjectStore.prototype.add = originalAdd;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    };
  });
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('Não foi possível salvar no aparelho');
  await expect(page.getByLabel('Modelo ou amperagem')).toHaveValue('80 Ah');
  await expect(page.getByLabel('Preço em BRL')).toHaveValue('520.00');
  const state = await offlineCounts(page);
  expect(state.events).toHaveLength(0);
  expect(state.drafts[0]).not.toHaveProperty('prices');
});

test('does not navigate or claim success when the atomic local commit fails', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function failVisitOutboxOnce(value: unknown, key?: IDBValidKey) {
      if (this.name === 'outboxEvents') {
        IDBObjectStore.prototype.add = originalAdd;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    };
  });
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page).toHaveURL(/\/route$/);
  await expect(page.getByRole('status')).toContainText('Não foi possível salvar o início da visita');
  const failed = await offlineCounts(page);
  expect(failed.drafts).toHaveLength(0);
  expect(failed.events).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Iniciar visita' })).toBeEnabled();
});

test('starts offline and synchronizes on reconnection without reloading or duplicating the draft', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await context.setOffline(true);
  await page.goto('/route');
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('A sincronização será retomada quando a conexão voltar.', { exact: false })).toBeVisible();
  const before = await offlineCounts(page);
  const url = page.url();
  expect(before.drafts).toHaveLength(1);
  expect(before.events).toHaveLength(1);
  await context.setOffline(false);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await expect(page).toHaveURL(url);
  const after = await offlineCounts(page);
  expect(after.drafts).toHaveLength(1);
  expect(after.events).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem('visit-sync-batches'))).toBe('1');
});

test('retries a lost response automatically with the exact same event and key', async ({ page }) => {
  await mockVisitSeller(page, 'lost-response');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('visit-sync-batches'))).toBe('2');
  expect(await page.evaluate(() => sessionStorage.getItem('same-visit-batch'))).toBe('true');
  const saved = await offlineCounts(page);
  expect(saved.drafts).toHaveLength(1);
  expect(saved.events).toHaveLength(0);
});

test('retries a lost stock response with the exact same event and key', async ({ page }) => {
  await mockVisitSeller(page, 'stock-lost-response');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.getByRole('button', { name: 'Preencher estoque' }).click();
  await page.getByLabel('Quantidade observada — Heliar').fill('0');
  await page.getByLabel('Quantidade observada — Moura').fill('3');
  await page.getByRole('button', { name: 'Salvar estoque e continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Salvo no aparelho', exact: true })).toBeVisible();
  // An empty outbox also exists before the save commits; observe the retry first.
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('visit-stock-sync-batches'))).toBe('2');
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('same-visit-stock-batch'))).toBe('true');
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    stock: { heliarQuantity: 0, mouraQuantity: 3, persistenceState: 'synced' },
  }]);
});

test('shows a definitive conflict without discarding the draft or retrying it', async ({ page }) => {
  await mockVisitSeller(page, 'conflict');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('A sincronização exige revisão', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Tentar sincronizar novamente' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('visit-sync-batches'))).toBe('1');
  const saved = await offlineCounts(page);
  expect(saved.drafts).toHaveLength(1);
  expect(saved.events).toMatchObject([{ status: 'action_required', lastErrorCode: 'IDEMPOTENCY_KEY_REUSED' }]);
  await expect(page.getByText('Sincronizada', { exact: true })).not.toBeVisible();
});

test('keeps a removed client visit accessible after a new composition, online and offline', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByText('A sincronização será retomada quando a conexão voltar.', { exact: false })).toBeVisible();
  const visitUrl = page.url();
  const pending = await offlineCounts(page);
  expect(pending.events).toHaveLength(1);
  await page.evaluate(() => sessionStorage.setItem('visit-route-revised', 'true'));
  await context.setOffline(false);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await page.goto('/route');
  await expect(page.getByRole('heading', { name: 'Novo cliente da rota' })).toBeVisible();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const savedVisits = page.getByRole('region', { name: 'Visitas salvas de outras versões' });
  await expect(savedVisits.getByRole('heading', { name: 'Cliente sintético da visita' })).toBeVisible();
  await expect(savedVisits.getByRole('button', { name: 'Iniciar visita' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('saved-visits-mobile.png'), fullPage: true });
  await savedVisits.getByRole('link', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  await expect(page.getByText('Início confirmado pelo servidor.')).toBeVisible();
  await context.setOffline(true);
  await page.goto('/route', { waitUntil: 'domcontentloaded' });
  await expect(savedVisits.getByRole('heading', { name: 'Cliente sintético da visita' })).toBeVisible();
  await savedVisits.getByRole('link', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  await expect(page.getByText('Sincronizada', { exact: true })).toBeVisible();
  const after = await offlineCounts(page);
  expect(after.drafts).toHaveLength(1);
  expect(after.drafts).toMatchObject([{ routeVersionStopId: routeStopId, canonicalVisitId }]);
  expect(after.events).toHaveLength(0);
});

for (const surface of ['loaded-route', 'offline-shell'] as const) {
  for (const signal of ['local-revocation', 'session-channel', 'identity-change', 'storage-clear'] as const) {
  test(`hides historical visits on ${surface} after cross-tab ${signal}`, async ({ page, context }) => {
    await mockVisitSeller(page, 'conflict');
    await page.goto('/route');
    await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar visita' }).click();
    await expect(page.getByText('A sincronização exige revisão', { exact: false })).toBeVisible();
    await page.evaluate(() => sessionStorage.setItem('visit-route-revised', 'true'));
    await page.goto('/route');
    await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
    const history = page.getByRole('region', { name: 'Visitas salvas de outras versões' });
    await expect(history.getByRole('heading', { name: 'Cliente sintético da visita' })).toBeVisible();
    await context.setOffline(true);
    if (surface === 'offline-shell') await page.goto('/route', { waitUntil: 'domcontentloaded' });
    await expect(history).toBeVisible();
    const saved = await offlineCounts(page);
    expect(saved.drafts).toHaveLength(1);
    expect(saved.events).toHaveLength(1);
    const otherTab = await context.newPage();
    await otherTab.goto('/route', { waitUntil: 'domcontentloaded' });
    // Test revocation of loaded views, not cancellation of the sender's session validation.
    await expect(otherTab.getByRole('region', { name: 'Visitas salvas de outras versões' })).toBeVisible();
    if (signal === 'local-revocation') {
      await otherTab.getByRole('button', { name: 'Bloquear acesso local' }).click();
      await expect(otherTab.getByRole('heading', { name: 'Acesso local bloqueado' })).toBeVisible();
    } else {
      await otherTab.evaluate((kind) => {
        if (kind === 'session-channel') {
          const channel = new BroadcastChannel('cirne-session');
          channel.postMessage('changed'); channel.close();
        } else if (kind === 'identity-change') {
          localStorage.setItem('cirne-rotas.last-user-id', 'another-seller');
        } else localStorage.clear();
      }, signal);
    }
    expect(await offlineCounts(page)).toEqual(saved);
    // Revocation must hide existing views, not only block subsequent navigation.
    await expect(page.getByRole('heading', { name: 'Cliente sintético da visita' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Novo cliente da rota' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continuar visita' })).toHaveCount(0);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(page.getByRole('heading', {
      name: surface === 'loaded-route' ? 'Entre para ver sua rota' : 'Acesso local bloqueado',
    })).toBeVisible();
    await expect(page.getByText('Rua do Teste, 31 — Recife, PE')).toHaveCount(0);
    expect(await offlineCounts(page)).toEqual(saved);
    expect(await page.evaluate(() => localStorage.getItem('cirne-rotas.last-user-id'))).toBe(
      signal === 'session-channel' ? sellerId : signal === 'identity-change' ? 'another-seller' : null,
    );
  });
  }
}

for (const signal of ['session-channel', 'local-revocation', 'identity-change', 'storage-clear'] as const) {
  test(`hides an open visit on cross-tab ${signal} and preserves its pending work`, async ({ page, context }) => {
    await mockVisitSeller(page, 'conflict');
    await page.goto('/route');
    await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
    await page.getByRole('button', { name: 'Iniciar visita' }).click();
    await expect(page.getByText('A sincronização exige revisão', { exact: false })).toBeVisible();
    const saved = await offlineCounts(page);
    expect(saved.drafts).toHaveLength(1);
    expect(saved.events).toHaveLength(1);
    const otherTab = await context.newPage();
    await otherTab.goto('/login');
    await otherTab.evaluate((kind) => {
      if (kind === 'session-channel') {
        const channel = new BroadcastChannel('cirne-session');
        channel.postMessage('changed');
        channel.close();
      } else if (kind === 'local-revocation') {
        localStorage.removeItem('cirne-rotas.last-user-id');
      } else if (kind === 'identity-change') {
        localStorage.setItem('cirne-rotas.last-user-id', 'another-seller');
      } else {
        localStorage.clear();
      }
    }, signal);
    await expect(page.getByRole('heading', { name: 'Acesso local bloqueado' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Cliente sintético da visita.' })).not.toBeVisible();
    await expect(page.getByText('Rua do Teste, 31 — Recife, PE')).not.toBeVisible();
    // Reconnection must not reactivate a controller whose access was revoked.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('heading', { name: 'Acesso local bloqueado' })).toBeVisible();
    expect(await offlineCounts(page)).toEqual(saved);
    expect(await page.evaluate(() => sessionStorage.getItem('visit-sync-batches'))).toBe('1');
  });
}
