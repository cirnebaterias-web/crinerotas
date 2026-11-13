import { expect, test, type Page } from '@playwright/test';
import axe from 'axe-core';
import type { CanonicalRoute, LocalAttachment, LocalVisitDraft, LocalVisitEvidence, MeResponse, OfflineOutboxEvent } from '@cirne/contracts';

const sellerId = '33333333-3333-4333-8333-333333333331';
const routeStopId = '33333333-3333-4333-8333-333333333334';
const canonicalVisitId = '33333333-3333-4333-8333-333333333399';
const competitorId = 'c1000000-0000-4000-8000-000000000001';
const ownPriceBrandId = 'c1000000-0000-4000-8000-000000000005';
const technologyId = 'c1000000-0000-4000-8000-000000000002';
const conditionId = 'c1000000-0000-4000-8000-000000000003';
const unavailableReasonId = 'c1000000-0000-4000-8000-000000000004';
const ownCommercialActionId = 'c1000000-0000-4000-8000-000000000006';
const protectedEvidenceMessage = 'Dados confirmados; evidências protegidas no aparelho aguardam o canal privado.';
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
    competitors: [
      { id: ownPriceBrandId, category: 'competitor' as const, code: 'synthetic_heliar', label: 'Heliar', sortOrder: 1 },
      { id: competitorId, category: 'competitor' as const, code: 'synthetic_competitor', label: 'Concorrente Sintético', sortOrder: 2 },
    ],
    technologies: [{ id: technologyId, category: 'competitor_price_technology' as const, code: 'synthetic_technology', label: 'Tecnologia Sintética', sortOrder: 1 }],
    conditions: [{ id: conditionId, category: 'competitor_price_condition' as const, code: 'synthetic_condition', label: 'Condição Sintética', sortOrder: 1 }],
    unavailableReasons: [{ id: unavailableReasonId, category: 'competitor_price_unavailable_reason' as const, code: 'synthetic_unavailable', label: 'Motivo Sintético', sortOrder: 1 }],
  },
};
const commercialActions = {
  schemaVersion: 1 as const,
  actions: [{
    id: ownCommercialActionId,
    title: 'Campanha Heliar sintética',
    description: 'Apresente as condições comerciais ao PDV.',
    validFrom: '2026-01-01',
    validUntil: '2027-12-31',
    active: true,
  }],
};

async function mockVisitSeller(
  page: Page,
  failure: 'none' | 'lost-response' | 'stock-lost-response' | 'conflict' = 'none',
  catalog: 'complete' | 'empty' = 'complete',
  recovery: 'none' | 'already_completed' | 'requires_sales' = 'none',
) {
  await page.addInitScript(({ identityFixture, routeFixture, revisedFixture, visitId, failureMode, parameterFixture, commercialActionsFixture, catalogMode, recoveryMode }) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { throw new DOMException('Synthetic camera unavailable', 'NotFoundError'); } },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: PositionCallback) => success({
        coords: {
          latitude: -8.047562,
          longitude: -34.876964,
          accuracy: 12.69,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      }) },
    });
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
      if (url.pathname === '/api/v1/commercial-actions') return json(commercialActionsFixture);
      if (recoveryMode !== 'none' && /^\/api\/v1\/visits\/[^/]+\/complete$/.test(url.pathname)) {
        const requests = JSON.parse(sessionStorage.getItem('legacy-recovery-requests') ?? '[]') as unknown[];
        requests.push({ operation: 'checkout', body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') });
        sessionStorage.setItem('legacy-recovery-requests', JSON.stringify(requests));
        if (recoveryMode === 'requires_sales' && sessionStorage.getItem('legacy-recovery-sales-accepted') !== 'true') {
          return json({ error: { code: 'EVENT_OUT_OF_ORDER', message: 'Falta o informe de venda.', recoverable: false,
            timestamp: '2026-11-12T19:00:00.000Z', requestId: visitId } }, 409);
        }
        const input = JSON.parse(String(init?.body)) as { offlineId: string; deviceCompletedAt: string };
        return json({ schemaVersion: 1, visitId, offlineId: input.offlineId, status: 'completed',
          deviceCompletedAt: input.deviceCompletedAt, serverCompletedAt: '2026-11-12T19:00:00.000Z' });
      }
      if (url.pathname === '/api/v1/attachments/upload-intents' ||
          /^\/api\/v1\/attachments\/[^/]+\/confirm$/.test(url.pathname) ||
          /^\/api\/v1\/visits\/[^/]+\/(?:evidence\/checkin|complete)$/.test(url.pathname)) {
        return json({
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: 'Canal privado de evidências ainda não habilitado.',
            recoverable: true,
            timestamp: '2026-09-17T12:01:00.000Z',
            requestId: '33333333-3333-4333-8333-333333333397',
          },
        }, 503);
      }
      if (url.pathname === '/api/v1/sync/batches') {
        const batch = JSON.parse(String(init?.body)) as {
          events: Array<{ eventId: string; operation: string }>;
        };
        const count = Number(sessionStorage.getItem('visit-sync-batches') ?? '0') + 1;
        sessionStorage.setItem('visit-sync-batches', String(count));
        const body = String(init?.body);
        if (recoveryMode !== 'none') {
          const requests = JSON.parse(sessionStorage.getItem('legacy-recovery-requests') ?? '[]') as unknown[];
          requests.push({ operation: 'sales', body });
          sessionStorage.setItem('legacy-recovery-requests', JSON.stringify(requests));
          sessionStorage.setItem('legacy-recovery-sales-accepted', 'true');
        }
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
    commercialActionsFixture: commercialActions,
    catalogMode: catalog,
    recoveryMode: recovery,
  });
}

async function startVisit(page: Page) {
  await page.getByRole('button', { name: 'Iniciar visita' }).click();
  await expect(page.getByRole('heading', { name: 'Foto da fachada e posição' })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  const streetConfirmation = page.getByLabel('Estou na rua indicada acima');
  if (await streetConfirmation.count()) await streetConfirmation.check();
  const justification = page.getByLabel('Justificativa obrigatória');
  if (await justification.count()) {
    await justification.fill('Câmera e GPS indisponíveis no cenário automatizado.');
  }
  await page.getByRole('button', { name: 'Confirmar e iniciar visita' }).click();
}

async function completeVisit(page: Page) {
  await expect(page).toHaveURL(/\?step=actions$/);
  const saveActions = page.getByRole('button', { name: 'Salvar ações comerciais' });
  await expect(saveActions).toBeVisible();
  const acknowledgements = page.getByLabel('Apresentei esta ação ao PDV');
  for (let index = 0; index < await acknowledgements.count(); index += 1) {
    await acknowledgements.nth(index).check();
  }
  await saveActions.click();
  await saveVisitSales(page);
  await page.getByRole('button', { name: /^Sucata/ }).click();
  await expect(page).toHaveURL(/\?step=scrap$/);
  if (await page.getByRole('radio', { name: 'Sem sucata', exact: true }).isVisible()) {
    await page.getByRole('radio', { name: 'Sem sucata', exact: true }).check();
  }
  await page.getByRole('button', { name: 'Confirmar sem sucata' }).click();
  await expect(page).toHaveURL(/\?step=review$/);
  await page.getByRole('button', { name: 'Encerrar visita' }).click();
  await expect(page.getByRole('heading', { name: 'Foto da fachada e posição' })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByLabel('Justificativa obrigatória').fill('Câmera e GPS indisponíveis no cenário automatizado.');
  await page.getByRole('button', { name: 'Confirmar e encerrar visita' }).click();
}

async function saveVisitSales(page: Page) {
  await expect(page).toHaveURL(/\?step=sales$/);
  await page.getByLabel('Heliar', { exact: true }).fill('0');
  await page.getByLabel('América', { exact: true }).fill('0');
  await page.getByLabel('Strada/Durex', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Salvar informe de venda' }).click();
  await expect(page.getByRole('button', { name: /Informe de venda na visita/ })).toContainText('Salvo no aparelho');
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
    const [drafts, events, attachments, evidence] = await Promise.all([
      read('visitDrafts'), read('outboxEvents'), read('attachments'), read('visitEvidence'),
    ]);
    database.close();
    return { drafts, events, attachments, evidence };
  });
}

async function seedLegacyPendingCheckout(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cirne-rotas-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['visitDrafts', 'visitEvidence', 'attachments', 'outboxEvents'], 'readwrite');
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    const drafts = await requestValue(tx.objectStore('visitDrafts').getAll()) as LocalVisitDraft[];
    const draft = drafts[0]!;
    // The legacy actions and scrap below are already canonical (events 4 and 5),
    // so preserve a valid aggregate history rather than the start-only sequence.
    const lastConfirmedSequence = Math.max(draft.lastConfirmedSequence ?? 0, 5);
    const partition = { userId: draft.userId, deviceId: draft.deviceId };
    const capturedAt = '2026-11-10T12:00:00.000Z';
    const checkout: LocalVisitEvidence = { schemaVersion: 1, ...partition,
      offlineId: '33333333-3333-4333-8333-333333333390', visitOfflineId: draft.offlineId, kind: 'checkout',
      capturedAt, latitude: '-8.047562', longitude: '-34.876964', accuracyM: '12.69', radiusM: 30,
      desiredAccuracyM: 50, issues: [], attachmentOfflineId: '33333333-3333-4333-8333-333333333391',
      status: 'pending', expiresAt: '2027-01-01T12:00:00.000Z' };
    const originalBytes = 'original legacy checkout photograph bytes';
    const blob = new Blob([originalBytes], { type: 'image/jpeg' });
    const photo: LocalAttachment = { schemaVersion: 1, ...partition, offlineId: checkout.attachmentOfflineId!,
      visitOfflineId: draft.offlineId, purpose: 'visit_checkout', fileName: 'legacy-checkout.jpg',
      contentType: 'image/jpeg', byteSize: blob.size, width: 20, height: 20, checksum: 'a'.repeat(64),
      capturedAt, status: 'verified', blob };
    const evidence = await requestValue(tx.objectStore('visitEvidence').getAll()) as LocalVisitEvidence[];
    for (const item of evidence) tx.objectStore('visitEvidence').put({ ...item, status: 'synced', serverSyncedAt: capturedAt });
    tx.objectStore('visitEvidence').put(checkout);
    tx.objectStore('attachments').put(photo);
    tx.objectStore('outboxEvents').clear();
    tx.objectStore('visitDrafts').put({ ...draft, localStatus: 'completed', currentStep: 'complete',
      lastConfirmedSequence,
      deviceCompletedAt: capturedAt, persistenceState: 'synced', sales: undefined,
      serverCompletedAt: undefined, salesCompletionRecovery: undefined, salesRecoveryResolution: undefined,
      commercialActions: { ownAcknowledgements: [], competitor: { availability: 'not_identified' },
        eventId: crypto.randomUUID(), deviceSavedAt: capturedAt, persistenceState: 'synced' },
      scrap: { availability: 'none', eventId: crypto.randomUUID(), deviceSavedAt: capturedAt, persistenceState: 'synced' },
    });
    await done;
    database.close();
    return { checkout, originalBytes, lastConfirmedSequence, offlineId: draft.offlineId };
  });
}

async function legacyCheckoutBytes(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cirne-rotas-offline');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const photos = await new Promise<LocalAttachment[]>((resolve, reject) => {
      const request = database.transaction('attachments').objectStore('attachments').getAll();
      request.onsuccess = () => resolve(request.result as LocalAttachment[]); request.onerror = () => reject(request.error);
    });
    database.close();
    return photos.find((photo) => photo.offlineId === '33333333-3333-4333-8333-333333333391')!.blob.text();
  });
}

const ownStockBrands = ['Heliar', 'América', 'Durex', 'ACDelco'] as const;

async function saveOwnBrandsWithoutStock(page: Page) {
  for (const brand of ownStockBrands) {
    await page.getByRole('button', { name: `${brand}: 0 unidades. Abrir modelos` }).click();
    await expect(page.getByRole('heading', { name: brand, exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: `Confirmo que não há estoque de ${brand} neste PDV` }).check();
    await page.getByRole('button', { name: `Salvar ${brand}` }).click();
  }
  await page.getByRole('button', { name: 'Continuar para estoque da concorrência' }).click();
  await expect(page.getByRole('heading', { name: 'Marcas concorrentes' })).toBeVisible();
}

async function saveNoCompetitorStockToPhotos(page: Page) {
  await page.getByRole('checkbox', { name: 'Não há estoque da concorrência neste PDV' }).check();
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await expect(page.getByRole('heading', { name: 'Análise do estoque' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await expect(page.getByRole('heading', { name: 'Fotos do estoque' })).toBeVisible();
}

async function addStockPhotos(page: Page, count = 3) {
  const pngDataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80; canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#008744'; context.fillRect(0, 0, 80, 60);
    return canvas.toDataURL('image/png');
  });
  const png = Buffer.from(pngDataUrl.split(',')[1]!, 'base64');
  await page.locator('input[type="file"]').setInputFiles(Array.from({ length: count }, (_, index) => ({
    name: `estoque-${index + 1}.png`, mimeType: 'image/png', buffer: png,
  })));
}

async function saveNoCompetitorStock(page: Page) {
  await saveNoCompetitorStockToPhotos(page);
  await addStockPhotos(page);
  await page.getByRole('button', { name: 'Concluir coleta de estoque' }).click();
  await expect(page.getByRole('button', { name: 'Coleta de estoque, concluída. Abrir detalhes' }))
    .toContainText('Concluído');
  await page.getByRole('button', { name: /Pesquisa de preços/ }).click();
  await expect(page.getByRole('heading', { name: 'Preços dos nossos produtos' })).toBeVisible();
}

async function saveEmptyStockToPrices(page: Page) {
  await saveOwnBrandsWithoutStock(page);
  await saveNoCompetitorStock(page);
}

test('stock insights survives offline reload, reopen, edit and contextual Back without extra writes', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: /Coleta de estoque/ }).click();
  await saveOwnBrandsWithoutStock(page);
  await page.getByRole('button', { name: 'Moura', exact: true }).click();
  await page.getByLabel('Amperagem (Ah)').fill('60');
  await page.getByLabel('Tecnologia').selectOption('SLI');
  await page.getByLabel('Quantidade', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await expect(page).toHaveURL(/step=stock-insights$/);
  await expect(page.getByRole('heading', { name: 'Análise do estoque' })).toBeFocused();
  await expect(page.getByText('Ausência no recorte observado', { exact: true })).toBeVisible();
  const before = await offlineCounts(page);
  expect((before.drafts[0] as LocalVisitDraft).stock!.collectionCompletedAt).toBeUndefined();
  const insightsUrl = page.url();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Análise do estoque' })).toBeVisible();
  expect(await offlineCounts(page)).toEqual(before);

  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await expect(page.getByRole('heading', { name: 'Fotos do estoque' })).toBeVisible();
  await addStockPhotos(page);
  await expect(page.getByText(/3 foto\(s\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page).toHaveURL(/step=stock-insights$/);
  await page.goBack();
  await expect(page).toHaveURL(/step=competitor-stock$/);
  await expect(page.getByLabel('Quantidade', { exact: true })).toHaveValue('7');
  await page.getByLabel('Quantidade', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await expect(page.getByText('Total observado').locator('..')).toContainText('9 un.');
  await page.getByRole('button', { name: 'Editar estoque' }).click();
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  await page.getByRole('button', { name: 'Aumentar HG38JD 24-320' }).click();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sair sem salvar?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar preenchendo' }).click();
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await page.getByRole('button', { name: 'Continuar para estoque da concorrência' }).click();
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await expect(page.getByText('Total observado').locator('..')).toContainText('10 un.');
  expect((await offlineCounts(page)).attachments).toHaveLength(3);
  const after = await offlineCounts(page);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(insightsUrl, { waitUntil: 'domcontentloaded' });
  await expect(reopened.getByRole('heading', { name: 'Análise do estoque' })).toBeVisible();
  expect(await offlineCounts(reopened)).toEqual(after);
  await reopened.getByRole('button', { name: 'Continuar para fotos' }).click();
  await reopened.goBack();
  await expect(reopened).toHaveURL(/step=stock-insights$/);
  await reopened.goBack();
  await expect(reopened).toHaveURL(/step=competitor-stock$/);
  expect(await offlineCounts(reopened)).toEqual(after);
});

test('stock insights is readable at mobile widths, keyboard and 200 percent zoom with axe', async ({ page }, testInfo) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await startVisit(page);
  await page.getByRole('button', { name: /Coleta de estoque/ }).click();
  await saveOwnBrandsWithoutStock(page);
  await page.getByRole('checkbox', { name: 'Não há estoque da concorrência neste PDV' }).check();
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await expect(page.getByRole('heading', { name: 'Análise do estoque' })).toBeFocused();
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of ['Editar estoque', 'Continuar para fotos']) {
      const action = page.getByRole('button', { name, exact: true });
      const box = await action.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`stock-insights-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () => (await (window as Window & { axe?: typeof axe }).axe!.run(document.querySelector('main')!, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
  })).violations);
  expect(violations).toEqual([]);
  await page.getByRole('button', { name: 'Continuar para fotos' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Fotos do estoque' })).toBeFocused();
});

test('stock insights calculation failure preserves saved data and offers photos and editing', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: /Coleta de estoque/ }).click();
  await saveOwnBrandsWithoutStock(page);
  await saveNoCompetitorStockToPhotos(page);
  await addStockPhotos(page);
  await expect(page.getByText(/3 foto\(s\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  // Each stored quantity is legal for the legacy stock schema, but their sum
  // exceeds the analytics safe integer bound. Exercise the real isolated failure.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cirne-rotas-offline');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = database.transaction('visitDrafts', 'readwrite');
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    const store = tx.objectStore('visitDrafts');
    const drafts = await new Promise<LocalVisitDraft[]>((resolve, reject) => {
      const request = store.getAll(); request.onsuccess = () => resolve(request.result as LocalVisitDraft[]);
      request.onerror = () => reject(request.error);
    });
    const draft = drafts[0]!;
    store.put({ ...draft, stock: { ...draft.stock,
      ownLines: [{ brand: 'Heliar', model: 'Modelo sintético extremo', quantity: Number.MAX_SAFE_INTEGER }],
      competitorLines: [{ brand: 'Moura', amperage: 60, technology: 'SLI', quantity: 1 }],
    } });
    await done; database.close();
  });
  const before = await offlineCounts(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Análise indisponível neste momento/)).toBeVisible();
  expect(await offlineCounts(page)).toEqual(before);
  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await expect(page.getByText(/3 foto\(s\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.getByRole('button', { name: 'Editar estoque' }).click();
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
  expect(await offlineCounts(page)).toEqual(before);
});

test('protects unsaved stock changes and requires confirmation to reopen a completed collection', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await startVisit(page);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveOwnBrandsWithoutStock(page);

  await page.getByRole('checkbox', { name: 'Não há estoque da concorrência neste PDV' }).check();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sair sem salvar?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar preenchendo' }).click();

  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await addStockPhotos(page);
  await page.getByRole('button', { name: 'Concluir coleta de estoque' }).click();
  const completedStock = page.getByRole('button', { name: 'Coleta de estoque, concluída. Abrir detalhes' });
  await expect(completedStock).toContainText('Concluído');
  await completedStock.click();
  await expect(page.getByRole('dialog', { name: 'Reabrir coleta de estoque?' })).toBeVisible();
  await page.getByRole('button', { name: 'Reabrir e editar' }).click();
  await expect(page).toHaveURL(/\?step=stock$/);
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
});

test('keeps route exit on the visit hub and makes Android back return one level', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await startVisit(page);

  await expect(page.getByRole('link', { name: 'Retornar à rota' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Pausar visita e voltar à rota' }).click();
  await expect(page.getByRole('dialog', { name: 'Pausar visita e voltar à rota?' })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar a visita' }).click();

  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await expect(page.getByRole('button', { name: 'Voltar', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /rota/i })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'O que você vai coletar?' })).toBeVisible();
});

test('starts online, confirms once and reopens the same visit after an offline hard refresh', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page).toHaveURL(/\/visit\/[0-9a-f-]+\?step=start$/i);
  const committed = await offlineCounts(page);
  expect(committed.drafts).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'Cliente sintético da visita.' })).toBeVisible();
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
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

test('saves repeatable stock with zero and other models offline, restores it and confirms it', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await expect(page).toHaveURL(/\?step=stock$/);
  await page.screenshot({ path: testInfo.outputPath('stock-own-mobile.png'), fullPage: true });
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  await page.screenshot({ path: testInfo.outputPath('stock-heliar-models-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Aumentar HG38JD 24-320' }).click();
  await page.getByLabel('Quantidade de HG38JD 24-320').fill('0');
  await page.getByRole('button', { name: '+ Outra — digitar modelo' }).click();
  await page.getByPlaceholder('Nome do modelo').fill('Modelo sintético Heliar');
  await page.getByRole('button', { name: /Aumentar outro modelo custom-/ }).click();
  await page.getByRole('button', { name: /Aumentar outro modelo custom-/ }).click();
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  for (const brand of ownStockBrands.slice(1)) {
    await page.getByRole('button', { name: `${brand}: 0 unidades. Abrir modelos` }).click();
    await expect(page.getByRole('heading', { name: brand, exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: `Confirmo que não há estoque de ${brand} neste PDV` }).check();
    if (brand === 'ACDelco') await page.getByLabel('Observação da coleta (opcional)').fill('Conferido no depósito');
    await page.getByRole('button', { name: `Salvar ${brand}` }).click();
  }
  await page.getByRole('button', { name: 'Continuar para estoque da concorrência' }).click();
  await expect(page.getByRole('heading', { name: 'Marcas concorrentes' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('stock-competitor-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Moura', exact: true }).click();
  await page.getByLabel('Amperagem (Ah)').fill('60');
  await page.getByLabel('Tecnologia').selectOption('SLI');
  await page.getByLabel('Quantidade', { exact: true }).fill('7');
  await page.screenshot({ path: testInfo.outputPath('stock-competitor-filled-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Adicionar outra bateria' }).click();
  await expect(page.getByLabel('Amperagem (Ah)').nth(1)).toBeFocused();
  await page.getByLabel('Amperagem (Ah)').nth(1).fill('70');
  await page.getByLabel('Tecnologia').nth(1).selectOption('AGM');
  await page.getByLabel('Quantidade', { exact: true }).nth(1).fill('0');
  await page.getByRole('button', { name: 'Adicionar outra bateria' }).click();
  await page.getByRole('button', { name: 'Remover bateria 3 da marca Moura' }).click();
  await expect(page.getByRole('button', { name: 'Adicionar outra bateria' })).toBeFocused();
  await page.getByRole('button', { name: 'Outra marca', exact: true }).click();
  await page.getByLabel('Nome da marca').fill('Marca sintética');
  await page.getByLabel('Amperagem (Ah)').fill('80');
  await page.getByLabel('Tecnologia').selectOption('EFB');
  await page.getByLabel('Quantidade', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await expect(page).toHaveURL(/\?step=stock-photos$/);
  await expect(page.getByRole('heading', { name: 'Fotos do estoque' })).toBeVisible();
  await addStockPhotos(page);
  await page.getByRole('button', { name: 'Concluir coleta de estoque' }).click();
  await page.getByRole('button', { name: /Pesquisa de preços/ }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  const saved = await offlineCounts(page);
  expect(saved.events).toHaveLength(5);
  expect((saved.events as Array<{ operation: string; sequence: number }>).map((event) => ({
    operation: event.operation, sequence: event.sequence,
  })).sort((a, b) => a.sequence - b.sequence)).toEqual(
    [2, 3, 4, 5, 6].map((sequence) => ({ operation: 'visit.stock.saved.v1', sequence })),
  );
  expect(saved.drafts).toMatchObject([{
    currentStep: 'prices',
    stock: {
      heliarQuantity: 2,
      mouraQuantity: 7,
      ownLines: [{ brand: 'Heliar', model: 'Modelo sintético Heliar', quantity: 2 }],
      completedOwnBrands: [...ownStockBrands],
      competitorLines: [
        { brand: 'Moura', amperage: 60, technology: 'SLI', quantity: 7 },
        { brand: 'Moura', amperage: 70, technology: 'AGM', quantity: 0 },
        { brand: 'Outra', otherBrand: 'Marca sintética', amperage: 80, technology: 'EFB', quantity: 1 },
      ],
      observation: 'Conferido no depósito', persistenceState: 'saved_on_device',
    },
  }]);

  const pricesUrl = page.url();
  await page.goto(pricesUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.getByRole('button', { name: /Coleta de estoque/ }).click();
  await page.getByRole('button', { name: 'Reabrir e editar' }).click();
  await page.getByRole('button', { name: 'Heliar: 2 unidades. Abrir modelos' }).click();
  await expect(page.getByPlaceholder('Nome do modelo')).toHaveValue('Modelo sintético Heliar');
  await page.goto(pricesUrl, { waitUntil: 'domcontentloaded' });
  await page.goto(page.url().replace('step=prices', 'step=competitor-stock'));
  await expect(page.getByLabel('Amperagem (Ah)')).toHaveCount(2);
  await expect(page.getByLabel('Quantidade', { exact: true }).nth(1)).toHaveValue('0');
  await page.getByRole('button', { name: 'Marca sintética', exact: false }).click();
  await expect(page.getByLabel('Nome da marca')).toHaveValue('Marca sintética');
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).click();
  await page.getByRole('button', { name: 'Continuar para fotos' }).click();
  await page.getByRole('button', { name: 'Concluir coleta de estoque' }).click();
  await page.getByRole('button', { name: /Pesquisa de preços/ }).click();

  await context.setOffline(false);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  const synchronized = await offlineCounts(page);
  expect(synchronized.drafts).toMatchObject([{
    stock: { heliarQuantity: 2, mouraQuantity: 7, persistenceState: 'synced' },
    lastConfirmedSequence: 7,
  }]);
  await page.goto('/route');
  await page.getByRole('button', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect(page.getByRole('heading', { name: 'Preços dos nossos produtos' })).toBeVisible();
});

test('does not claim stock success when prices is opened before a durable stock commit', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.goto(page.url().replace('step=start', 'step=prices'));
  await expect(page).toHaveURL(/\?step=stock$/);
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salvo no aparelho' })).toHaveCount(0);
  await saveOwnBrandsWithoutStock(page);
  await page.goto(page.url().replace('step=competitor-stock', 'step=prices'));
  await expect(page).toHaveURL(/\?step=competitor-stock$/);
  await expect(page.getByRole('heading', { name: 'Marcas concorrentes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salvo no aparelho' })).toHaveCount(0);
  await saveNoCompetitorStock(page);
});

test('can save a brand out of order and return to the stock overview', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await page.getByRole('button', { name: 'América: 0 unidades. Abrir modelos' }).click();
  await page.getByRole('button', { name: 'Aumentar AM100LE A 15M' }).click();
  await page.getByRole('button', { name: 'Salvar América' }).click();
  await expect(page.getByText('1 de 4 marcas concluídas')).toBeVisible();
  await expect(page.getByText('Total geral').locator('..')).toContainText('1 un.');
  await expect(page.getByRole('button', { name: 'Continuar para estoque da concorrência' })).toBeDisabled();
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    stock: { completedOwnBrands: ['América'], ownLines: [{ brand: 'América', model: 'AM100LE A 15M', quantity: 1 }] },
  }]);
});

test('keeps stock validation and step transitions usable by keyboard on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  const entry = page.getByRole('button', { name: 'Coleta de estoque' });
  await entry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeFocused();
  const brand = page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' });
  await brand.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Heliar', exact: true })).toBeFocused();
  const plus = page.getByRole('button', { name: 'Aumentar HG38JD 24-320' });
  const quantity = page.getByLabel('Quantidade de HG38JD 24-320');
  for (const control of [plus, quantity]) {
    const box = await control.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  await plus.focus();
  await page.keyboard.press('Enter');
  await expect(quantity).toHaveValue('1');
  await page.screenshot({ path: testInfo.outputPath('stock-mobile-filled.png'), fullPage: true });
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  for (const item of ownStockBrands.slice(1)) {
    await page.getByRole('button', { name: `${item}: 0 unidades. Abrir modelos` }).click();
    await page.getByRole('checkbox', { name: `Confirmo que não há estoque de ${item} neste PDV` }).check();
    await page.getByRole('button', { name: `Salvar ${item}` }).click();
  }
  await page.getByRole('button', { name: 'Continuar para estoque da concorrência' }).click();
  await expect(page.getByRole('heading', { name: 'Marcas concorrentes' })).toBeFocused();
  await page.getByRole('checkbox', { name: 'Não há estoque da concorrência neste PDV' }).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Salvar concorrência e ver análise' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Análise do estoque' })).toBeFocused();
  await page.getByRole('button', { name: 'Continuar para fotos' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Fotos do estoque' })).toBeFocused();
  await addStockPhotos(page);
  await page.getByRole('button', { name: 'Concluir coleta de estoque' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /Pesquisa de preços/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Preços dos nossos produtos' })).toBeFocused();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('stock-mobile-320.png'), fullPage: true });
});

test('requires three and limits/restores up to five stock photos offline', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: /Coleta de estoque/ }).click();
  await saveOwnBrandsWithoutStock(page);
  await saveNoCompetitorStockToPhotos(page);

  const pngDataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 80;
    canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#d71920';
    context.fillRect(0, 0, 80, 60);
    context.fillStyle = '#fff';
    context.fillRect(15, 15, 50, 30);
    return canvas.toDataURL('image/png');
  });
  const png = Buffer.from(pngDataUrl.split(',')[1]!, 'base64');
  const input = page.locator('input[type="file"]');
  await input.setInputFiles([
    { name: 'estoque-valido.png', mimeType: 'image/png', buffer: png },
    { name: 'nao-e-foto.txt', mimeType: 'text/plain', buffer: Buffer.from('texto') },
  ]);
  await expect(page.locator('.seller-field-error[role="alert"]')).toContainText('somente arquivos de imagem');
  expect((await offlineCounts(page)).attachments).toHaveLength(0);
  await input.setInputFiles({ name: 'estoque-1.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText(/1 foto\(s\).*2 obrigatória\(s\) restante\(s\).*máximo 5/)).toBeVisible();
  await expect(page.getByAltText('Foto 1 de 1 do estoque')).toBeVisible();
  await expect(page.getByRole('button', { name: /Adicione mais 2 foto/ })).toBeDisabled();
  const firstState = await offlineCounts(page);
  expect(firstState.attachments).toMatchObject([{
    purpose: 'stock_evidence', contentType: 'image/jpeg', status: 'pending',
  }]);
  expect((firstState.attachments[0] as { byteSize: number; checksum: string }).byteSize).toBeLessThan(2 * 1024 * 1024);
  expect((firstState.attachments[0] as { checksum: string }).checksum).toMatch(/^[a-f0-9]{64}$/);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/1 foto\(s\).*máximo 5/)).toBeVisible();
  await input.setInputFiles([
    { name: 'estoque-2.png', mimeType: 'image/png', buffer: png },
    { name: 'estoque-3.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.getByText(/3 foto\(s\).*mínimo obrigatório atingido.*máximo 5/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir coleta de estoque' })).toBeEnabled();
  await input.setInputFiles([
    { name: 'estoque-4.png', mimeType: 'image/png', buffer: png },
    { name: 'estoque-5.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.getByRole('button', { name: 'Limite de 5 fotos atingido' })).toBeDisabled();
  await input.setInputFiles({ name: 'estoque-6.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.seller-field-error[role="alert"]')).toContainText('no máximo 5 fotos');
  await page.getByRole('button', { name: 'Remover foto 2 de 5' }).click();
  await expect(page.getByText(/4 foto\(s\).*máximo 5/)).toBeVisible();
  expect((await offlineCounts(page)).attachments).toHaveLength(4);
});

test('validates empty, negative and decimal stock quantities without advancing', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  const quantity = page.getByLabel('Quantidade de HG38JD 24-320');
  const submit = page.getByRole('button', { name: 'Salvar Heliar' });
  await submit.click();
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('estoque zerado');
  await expect(page).toHaveURL(/step=stock&brand=Heliar/);

  await quantity.fill('-1');
  await submit.click();
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('números inteiros');

  await quantity.fill('1.5');
  await submit.click();
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('números inteiros');
  await quantity.fill('0');
  await page.getByRole('button', { name: '+ Outra — digitar modelo' }).click();
  await page.getByRole('button', { name: /Aumentar outro modelo custom-/ }).click();
  await submit.click();
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('Digite o nome');
  await expect(page).toHaveURL(/step=stock&brand=Heliar/);
  expect((await offlineCounts(page)).events).toHaveLength(0);
});

test('keeps stock values on screen when the atomic local commit fails', async ({ page }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  await page.getByRole('button', { name: '+ Outra — digitar modelo' }).click();
  await page.getByPlaceholder('Nome do modelo').fill('Modelo que não pode sumir');
  await page.getByRole('button', { name: /Aumentar outro modelo custom-/ }).click();
  await page.locator('.seller-stock-other-row input[aria-label^="Quantidade"]').fill('4');
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
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await expect(page).toHaveURL(/step=stock&brand=Heliar/);
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText(
    'Não foi possível salvar no aparelho',
  );
  await expect(page.getByPlaceholder('Nome do modelo')).toHaveValue('Modelo que não pode sumir');
  await expect(page.locator('.seller-stock-other-row input[aria-label^="Quantidade"]')).toHaveValue('4');
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
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);
  await expect(page.getByRole('heading', { name: 'Preços dos nossos produtos' })).toBeFocused();

  await page.getByRole('button', { name: /Heliar: 0 preços/ }).click();
  await page.getByLabel('Buscar modelo').fill('HG38JD 24-320');
  await page.getByLabel('Preço de venda de HG38JD 24-320').fill('399,90');
  await page.getByLabel('Tecnologia confirmada').selectOption(technologyId);
  await page.getByLabel('Condição confirmada').selectOption(conditionId);
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await page.getByRole('button', { name: 'Continuar para preços da concorrência' }).click();
  await page.getByRole('button', { name: 'Concorrente Sintético', exact: true }).click();
  await page.getByLabel('Modelo ou amperagem').fill('70 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço de venda (R$)').fill('459.50');
  await page.getByLabel('Condição').selectOption(conditionId);
  await page.getByRole('button', { name: 'Adicionar outra bateria' }).click();
  await expect(page.getByLabel('Modelo ou amperagem').nth(1)).toBeFocused();
  await page.getByRole('button', { name: 'Remover bateria 2 da marca Concorrente Sintético' }).click();
  await expect(page.getByRole('button', { name: 'Adicionar outra bateria' })).toBeFocused();
  await page.getByRole('button', { name: 'Revisar preços informados' }).click();
  await expect(page.getByRole('heading', { name: 'Confira antes de salvar' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar e salvar preços' }).click();

  await expect(page).toHaveURL(/\?step=actions$/);
  await expect(page.getByRole('heading', { name: 'Heliar', exact: true })).toBeVisible();
  await expect(page.getByText('Campanha Heliar sintética')).toBeVisible();
  await page.getByLabel('Apresentei esta ação ao PDV').check();
  await page.getByLabel('Identifiquei ação').check();
  await page.getByLabel('Concorrente').selectOption(competitorId);
  await page.getByLabel('Tipo de ação').selectOption('differentiated_price');
  await page.getByLabel('Descrição da ação').fill('Preço promocional para o PDV sintético.');
  await page.getByRole('button', { name: 'Salvar ações comerciais' }).click();
  await saveVisitSales(page);
  await page.getByRole('button', { name: /^Sucata/ }).click();
  await expect(page).toHaveURL(/\?step=scrap$/);
  await expect(page.getByRole('button', { name: 'Encerrar visita' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Sem sucata', exact: true }).check();
  await page.getByRole('button', { name: 'Confirmar sem sucata' }).click();
  await expect(page).toHaveURL(/\?step=review$/);
  await expect(page.getByRole('heading', { name: 'Salvas no aparelho' })).toBeFocused();
  const saved = await offlineCounts(page);
  expect(saved.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ operation: 'visit.stock.saved.v1', sequence: 2 }),
    expect.objectContaining({ operation: 'visit.stock.saved.v1', sequence: 6 }),
    expect.objectContaining({ operation: 'visit.prices.saved.v1', sequence: 7 }),
    expect.objectContaining({ operation: 'visit.commercial-actions.saved.v1', sequence: 8 }),
    expect.objectContaining({ operation: 'visit.sales.saved.v1', sequence: 9 }),
    expect.objectContaining({ operation: 'visit.scrap.saved.v1', sequence: 10 }),
  ]));
  expect(saved.drafts).toMatchObject([{
    currentStep: 'review',
    prices: { availability: 'available', quotations: [{ priceBrl: '399.90' }, { priceBrl: '459.50' }] },
    commercialActions: { competitor: { availability: 'identified' } },
    sales: { heliarQuantity: 0, americaQuantity: 0, stradaDurexQuantity: 0 },
    scrap: { availability: 'none' },
  }]);

  const actionsUrl = page.url();
  await page.goto(actionsUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('1 ação(ões) concorrente(s) registrada(s).')).toBeVisible();
  await page.getByRole('button', { name: 'Voltar', exact: true }).click();
  await page.getByRole('button', { name: /Pesquisa de preços/ }).click();
  await page.getByRole('button', { name: /Heliar: 1 preços/ }).click();
  await page.getByLabel('Buscar modelo').fill('HG38JD 24-320');
  await expect(page.getByLabel('Preço de venda de HG38JD 24-320')).toHaveValue('399.90');
  await page.getByRole('button', { name: '‹ Todas as marcas' }).click();
  await page.getByRole('button', { name: 'Continuar para preços da concorrência' }).click();
  await page.getByRole('button', { name: 'Concorrente Sintético 1 preço' }).click();
  await expect(page.getByLabel('Modelo ou amperagem')).toHaveValue('70 Ah');
  await context.setOffline(false);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    prices: { availability: 'available', persistenceState: 'synced' },
    commercialActions: { persistenceState: 'synced' },
    sales: { persistenceState: 'synced' },
    scrap: { availability: 'none', persistenceState: 'synced' },
    lastConfirmedSequence: 10,
  }]);
});

test('persists explicit sales zeros, keeps failed edits and reopens the same storage offline', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByRole('button', { name: 'Coleta de estoque' })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);
  await page.getByLabel('Preço não disponível').check();
  await page.getByLabel('Motivo da indisponibilidade').selectOption(unavailableReasonId);
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await page.getByLabel('Apresentei esta ação ao PDV').check();
  await page.getByRole('button', { name: 'Salvar ações comerciais' }).click();
  await expect(page).toHaveURL(/\?step=sales$/);
  const salesUrl = page.url();
  for (const label of ['Heliar', 'América', 'Strada/Durex']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Salvar informe de venda' }).click();
  await expect(page.locator('#sales-heliarQuantity-error')).toBeVisible();
  await expect(page.getByLabel('Heliar', { exact: true })).toBeFocused();
  await saveVisitSales(page);
  expect((await offlineCounts(page)).drafts).toMatchObject([{ sales: { heliarQuantity: 0, americaQuantity: 0, stradaDurexQuantity: 0 } }]);

  await page.close();
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 390, height: 844 });
  await mockVisitSeller(reopened);
  await reopened.goto(salesUrl, { waitUntil: 'domcontentloaded' });
  for (const label of ['Heliar', 'América', 'Strada/Durex']) await expect(reopened.getByLabel(label, { exact: true })).toHaveValue('0');
  await reopened.getByLabel('América', { exact: true }).fill('4');
  await reopened.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function failSalesOutboxOnce(value: unknown, key?: IDBValidKey) {
      if (this.name === 'outboxEvents') {
        IDBObjectStore.prototype.add = originalAdd;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
    };
  });
  await reopened.getByRole('button', { name: 'Salvar informe de venda' }).click();
  await expect(reopened.getByRole('alert').filter({ hasText: 'Não foi possível salvar no aparelho' })).toBeVisible();
  await expect(reopened).toHaveURL(salesUrl);
  await expect(reopened.getByLabel('América', { exact: true })).toHaveValue('4');
  expect((await offlineCounts(reopened)).drafts).toMatchObject([{ sales: { americaQuantity: 0 } }]);
  await reopened.screenshot({ path: testInfo.outputPath('visit-sales-mobile-failed-edit.png'), fullPage: true });
  await reopened.getByRole('button', { name: 'Salvar informe de venda' }).click();
  await expect(reopened.getByRole('button', { name: /Informe de venda na visita/ })).toContainText('Salvo no aparelho');
  await reopened.getByRole('button', { name: /Informe de venda na visita/ }).click();
  await expect(reopened.getByLabel('América', { exact: true })).toHaveValue('4');
  expect((await offlineCounts(reopened)).drafts).toMatchObject([{ sales: { heliarQuantity: 0, americaQuantity: 4, stradaDurexQuantity: 0 } }]);
  expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reopened.screenshot({ path: testInfo.outputPath('visit-sales-mobile-restored.png'), fullPage: true });
});

for (const mode of ['already_completed', 'requires_sales'] as const) {
  test(`recovers a completed legacy checkout offline and resolves ${mode} without replacing its evidence`, async ({ page, context }, testInfo) => {
    await mockVisitSeller(page);
    await page.goto('/route');
    await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
    await startVisit(page);
    await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
    await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
    await context.setOffline(true);
    const legacy = await seedLegacyPendingCheckout(page);
    const url = new URL(page.url()); url.searchParams.set('step', 'complete');
    await page.close();

    const reopened = await context.newPage();
    await reopened.setViewportSize({ width: 390, height: 844 });
    await mockVisitSeller(reopened, 'none', 'complete', mode);
    await reopened.goto(url.href, { waitUntil: 'domcontentloaded' });
    await expect(reopened).toHaveURL(/\?step=sales$/);
    await expect(reopened.getByText(/não é necessário refazer as evidências/)).toBeVisible();
    await expect(reopened.locator('.seller-task-list')).toHaveCount(0);
    await expect(reopened.getByRole('button', { name: 'Encerrar visita', exact: true })).toHaveCount(0);
    await expect(reopened.locator('input[type="file"]')).toHaveCount(0);
    for (const label of ['Heliar', 'América', 'Strada/Durex']) await expect(reopened.getByLabel(label, { exact: true })).toHaveValue('');
    const restored = await offlineCounts(reopened);
    expect(restored.drafts).toMatchObject([{ localStatus: 'completed', currentStep: 'sales',
      deviceCompletedAt: legacy.checkout.capturedAt, salesCompletionRecovery: true }]);
    expect(restored.evidence).toEqual(expect.arrayContaining([legacy.checkout]));
    expect(await legacyCheckoutBytes(reopened)).toBe(legacy.originalBytes);

    await reopened.getByLabel('Heliar', { exact: true }).fill('0');
    await reopened.getByLabel('América', { exact: true }).fill('2');
    await reopened.getByLabel('Strada/Durex', { exact: true }).fill('3');
    await reopened.getByRole('button', { name: 'Salvar informe de venda' }).click();
    await expect(reopened).toHaveURL(/\?step=complete$/);
    await expect(reopened.getByText('Informe salvo. Ao conectar, verificaremos primeiro o checkout original; as vendas só serão enviadas se ele ainda estiver pendente.')).toBeVisible();
    await expect(reopened.getByRole('button', { name: 'Editar informe pendente' })).toBeVisible();
    const pending = await offlineCounts(reopened);
    expect(pending.drafts).toMatchObject([{ localStatus: 'completed', currentStep: 'complete',
      deviceCompletedAt: legacy.checkout.capturedAt, sales: { heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 3 } }]);
    expect(pending.evidence).toEqual(expect.arrayContaining([legacy.checkout]));
    const salesEvent = (pending.events as OfflineOutboxEvent[]).find((event) => event.operation === 'visit.sales.saved.v1')!;
    expect(salesEvent.sequence).toBe((legacy.lastConfirmedSequence ?? 0) + 1);
    await reopened.screenshot({ path: testInfo.outputPath(`legacy-sales-${mode}-offline.png`), fullPage: true });

    await context.setOffline(false);
    await expect.poll(async () => ((await offlineCounts(reopened)).drafts[0] as LocalVisitDraft).serverCompletedAt)
      .toBe('2026-11-12T19:00:00.000Z');
    const confirmed = await offlineCounts(reopened);
    const draft = confirmed.drafts[0] as LocalVisitDraft;
    const requests = await reopened.evaluate(() => JSON.parse(sessionStorage.getItem('legacy-recovery-requests') ?? '[]')) as Array<{
      operation: 'checkout' | 'sales'; body: string; key?: string;
    }>;
    expect(requests.map((request) => request.operation)).toEqual(mode === 'already_completed'
      ? ['checkout'] : ['checkout', 'sales', 'checkout']);
    const checkouts = requests.filter((request) => request.operation === 'checkout');
    for (const request of checkouts) {
      expect(request.key).toBe(legacy.checkout.offlineId);
      expect(JSON.parse(request.body)).toMatchObject({ offlineId: legacy.offlineId,
        deviceCompletedAt: legacy.checkout.capturedAt, evidence: { offlineId: legacy.checkout.offlineId,
          capturedAt: legacy.checkout.capturedAt, attachmentOfflineId: legacy.checkout.attachmentOfflineId,
          location: { latitude: legacy.checkout.latitude, longitude: legacy.checkout.longitude, accuracyM: legacy.checkout.accuracyM } } });
    }
    expect(draft.localStatus).toBe('completed');
    expect(draft.deviceCompletedAt).toBe(legacy.checkout.capturedAt);
    expect(draft.salesCompletionRecovery).toBeUndefined();
    expect(confirmed.events).toEqual([]);
    expect(confirmed.evidence).toEqual(expect.arrayContaining([{ ...legacy.checkout, status: 'synced', serverSyncedAt: draft.serverCompletedAt }]));
    expect(await legacyCheckoutBytes(reopened)).toBe(legacy.originalBytes);
    if (mode === 'already_completed') {
      expect(draft.sales).toBeUndefined();
      expect(draft.salesRecoveryResolution).toMatchObject({ outcome: 'server_already_completed', cancelledSalesEvents: [{
        eventId: salesEvent.eventId, idempotencyKey: salesEvent.idempotencyKey, sequence: salesEvent.sequence, payload: salesEvent.payload,
      }] });
      await expect(reopened.getByText(/o registro dessa resolução foi preservado/)).toBeVisible();
    } else {
      expect(checkouts[0]!.body).toBe(checkouts[1]!.body);
      const submitted = JSON.parse(requests.find((request) => request.operation === 'sales')!.body);
      expect(submitted.events).toHaveLength(1);
      expect(submitted.events[0]).toMatchObject({ operation: 'visit.sales.saved.v1', eventId: salesEvent.eventId,
        idempotencyKey: salesEvent.idempotencyKey, payload: salesEvent.payload });
      expect(draft.sales).toMatchObject({ heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 3, persistenceState: 'synced' });
      expect(draft.salesRecoveryResolution).toBeUndefined();
    }
    await expect(reopened.getByRole('button', { name: 'Editar informe pendente' })).toHaveCount(0);
    url.searchParams.set('step', 'sales');
    await reopened.goto(url.href, { waitUntil: 'domcontentloaded' });
    await expect(reopened).toHaveURL(/\?step=complete$/);
    await expect(reopened.getByRole('button', { name: 'Salvar informe de venda' })).toHaveCount(0);
  });
}

for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }]) {
test(`reuses own products found in stock without overlap at ${viewport.width}px`, async ({ page, context }) => {
  await page.setViewportSize(viewport);
  await mockVisitSeller(page);
  await page.goto('/route');
  await startVisit(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();

  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  await page.locator('#quantity-502000030').fill('2');
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  for (const brand of ['América', 'Durex', 'ACDelco'] as const) {
    await page.getByRole('button', { name: `${brand}: 0 unidades. Abrir modelos` }).click();
    await page.getByRole('checkbox', { name: `Confirmo que não há estoque de ${brand} neste PDV` }).check();
    await page.getByRole('button', { name: `Salvar ${brand}` }).click();
  }
  await page.getByRole('button', { name: 'Continuar para estoque da concorrência' }).click();
  await saveNoCompetitorStock(page);

  await expect(page.getByRole('button', { name: /Heliar: 0 preços/ })).toContainText('1 produto(s) encontrado(s) no estoque');
  await page.getByRole('button', { name: /Heliar: 0 preços/ }).click();
  await expect(page.getByText('Em estoque: 2 un.')).toBeVisible();
  await page.getByLabel('Preço de venda de HG38JD 24-320').fill('529');
  const pricedProduct = page.getByLabel('Preço de venda de HG38JD 24-320').locator('..').locator('..');
  const nextProduct = pricedProduct.locator('+ .seller-price-product-row');
  await expect(page.getByLabel('Tecnologia confirmada')).toBeVisible();
  await expect(page.getByLabel('Condição confirmada')).toBeVisible();
  const [pricedBox, confirmationBox, nextBox] = await Promise.all([
    pricedProduct.boundingBox(), pricedProduct.locator('.seller-price-confirmation-fields').boundingBox(), nextProduct.boundingBox(),
  ]);
  expect(pricedBox).not.toBeNull();
  expect(confirmationBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  expect(confirmationBox!.y + confirmationBox!.height).toBeLessThanOrEqual(pricedBox!.y + pricedBox!.height + 1);
  expect(pricedBox!.y + pricedBox!.height).toBeLessThanOrEqual(nextBox!.y + 1);
  expect(await page.locator('.seller-stock-model-list').evaluate((element) => ({
    maxHeight: getComputedStyle(element).maxHeight, overflowY: getComputedStyle(element).overflowY,
  }))).toEqual({ maxHeight: 'none', overflowY: 'visible' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByLabel('Tecnologia confirmada').selectOption(technologyId);
  await page.getByLabel('Condição confirmada').selectOption(conditionId);
  await page.getByLabel('Buscar modelo').fill('HTZ12S-BS');
  await page.getByLabel('Preço de venda de HTZ12S-BS').fill('279,90');
  await page.getByLabel('Tecnologia confirmada').selectOption(technologyId);
  await page.getByLabel('Condição confirmada').selectOption(conditionId);
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await expect(page.getByRole('button', { name: /Heliar: 2 preços/ })).toContainText('Preços preparados');
  await page.getByRole('button', { name: /Heliar: 2 preços/ }).click();
  await page.getByLabel('Buscar modelo').fill('HTZ12S-BS');
  await page.getByLabel('Preço de venda de HTZ12S-BS').fill('');
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await expect(page.getByRole('button', { name: /Heliar: 1 preços/ })).toBeVisible();
});
}

for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }]) {
test(`rejects a non-positive competitor price without overlap at ${viewport.width}px`, async ({ page, context }) => {
  await page.setViewportSize(viewport);
  await mockVisitSeller(page);
  await page.goto('/route');
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);

  await page.getByRole('button', { name: 'Continuar para preços da concorrência' }).click();
  await page.getByRole('button', { name: 'Concorrente Sintético', exact: true }).click();
  await page.getByLabel('Modelo ou amperagem').fill('50 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço de venda (R$)').fill('0');
  await page.getByLabel('Condição').selectOption(conditionId);
  const competitorRow = page.getByLabel('Modelo ou amperagem').locator('..').locator('..').locator('..');
  const competitorBox = await competitorRow.boundingBox();
  expect(competitorBox).not.toBeNull();
  expect(competitorBox!.x).toBeGreaterThanOrEqual(0);
  expect(competitorBox!.x + competitorBox!.width).toBeLessThanOrEqual(viewport.width);
  const fieldBoxes = await competitorRow.locator('.seller-stock-field').evaluateAll((fields) => fields.map((field) => {
    const box = field.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
  }));
  for (let index = 1; index < fieldBoxes.length; index += 1) {
    expect(fieldBoxes[index]!.top).toBeGreaterThanOrEqual(fieldBoxes[index - 1]!.bottom - 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByLabel('Observação (opcional)').focus();
  await expect(page.getByLabel('Observação (opcional)')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Remover bateria 1 da marca Concorrente Sintético' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revisar preços informados' })).toBeVisible();
  await page.getByRole('button', { name: 'Revisar preços informados' }).click();
  await expect(page.getByText('Informe um preço de venda maior que zero. Exemplo: 399,90.')).toBeVisible();
  await expect(page.getByLabel('Preço de venda (R$)')).toBeFocused();
  await page.getByRole('button', { name: 'Revisar preços informados' }).click();
  await expect(page.getByLabel('Preço de venda (R$)')).toBeFocused();
  await expect(page).toHaveURL(/\?step=prices&priceView=competitors$/);

  await page.getByLabel('Preço de venda (R$)').fill('399');
  await page.getByLabel('Tecnologia').selectOption('');
  await page.getByLabel('Condição').selectOption('');
  await page.getByRole('button', { name: 'Revisar preços informados' }).click();
  await expect(page.getByLabel('Tecnologia')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Tecnologia')).toHaveAttribute('aria-describedby', /technologyId-error$/);
  await expect(page.getByLabel('Condição')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Condição')).toHaveAttribute('aria-describedby', /conditionId-error$/);
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Condição').selectOption(conditionId);

  await page.getByLabel('Preço não disponível').check();
  await page.getByLabel('Motivo da indisponibilidade').selectOption(unavailableReasonId);
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await expect(page).toHaveURL(/\?step=actions$/);
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    prices: { availability: 'unavailable', unavailableReasonId },
  }]);
});
}

test('ends a visit only after a camera-only checkout and a point-in-time GPS attempt', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  // The commercial catalog must finish its validated cache write before connectivity is lost.
  await expect(page.getByRole('button', { name: 'Coleta de estoque' })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);
  await page.getByLabel('Preço não disponível').check();
  await page.getByLabel('Motivo da indisponibilidade').selectOption(unavailableReasonId);
  await page.getByRole('button', { name: 'Salvar preços e continuar' }).click();
  await completeVisit(page);
  await expect(page).toHaveURL(/\?step=complete$/);
  await expect(page.getByRole('heading', { name: 'Checkout salvo no aparelho' })).toBeVisible();
  const state = await offlineCounts(page);
  expect(state.drafts).toMatchObject([{ localStatus: 'completed', currentStep: 'complete' }]);
  expect(state.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'checkin', radiusM: 30, desiredAccuracyM: 50 }),
    expect.objectContaining({ kind: 'checkout', radiusM: 30, desiredAccuracyM: 50 }),
  ]));
});

test('does not invent a prices response when the approved catalog is unavailable', async ({ page, context }) => {
  await mockVisitSeller(page, 'none', 'empty');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);
  await expect(page.getByText('Configuração comercial indisponível.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continuar para preços da concorrência' }).click();
  await expect(page.getByRole('button', { name: 'Revisar preços informados' })).toBeDisabled();
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
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await saveEmptyStockToPrices(page);
  await expect(page).toHaveURL(/\?step=prices$/);
  await expect.poll(() => page.evaluate(
    () => Number(sessionStorage.getItem('visit-stock-sync-batches') ?? '0'),
  )).toBeGreaterThan(0);
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Continuar para preços da concorrência' }).click();
  await page.getByRole('button', { name: 'Concorrente Sintético', exact: true }).click();
  await page.getByLabel('Modelo ou amperagem').fill('80 Ah');
  await page.getByLabel('Tecnologia').selectOption(technologyId);
  await page.getByLabel('Preço de venda (R$)').fill('520.00');
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
  await page.getByRole('button', { name: 'Revisar preços informados' }).click();
  await page.getByRole('button', { name: 'Confirmar e salvar preços' }).click();
  await expect(page).toHaveURL(/\?step=prices&priceView=review$/);
  await expect(page.locator('.seller-form-error[role="alert"]')).toContainText('Não foi possível salvar no aparelho');
  await page.getByRole('button', { name: '‹ Editar preços' }).click();
  await page.getByRole('button', { name: 'Concorrente Sintético 1 preço' }).click();
  await expect(page.getByLabel('Modelo ou amperagem')).toHaveValue('80 Ah');
  await expect(page.getByLabel('Preço de venda (R$)')).toHaveValue('520.00');
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
  await startVisit(page);
  await expect(page).toHaveURL(/\/route$/);
  await expect(page.locator('.seller-notice[role="status"]')).toContainText('Não foi possível salvar o início da visita');
  const failed = await offlineCounts(page);
  expect(failed.drafts).toHaveLength(0);
  expect(failed.events).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Iniciar visita', exact: true })).toBeEnabled();
});

test('starts offline and synchronizes on reconnection without reloading or duplicating the draft', async ({ page, context }) => {
  await mockVisitSeller(page);
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await context.setOffline(true);
  await startVisit(page);
  await expect(page.getByText('A sincronização será retomada quando a conexão voltar.', { exact: false })).toBeVisible();
  const before = await offlineCounts(page);
  const url = page.url();
  expect(before.drafts).toHaveLength(1);
  expect(before.events).toHaveLength(1);
  await context.setOffline(false);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
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
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
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
  await startVisit(page);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  await page.getByRole('button', { name: 'Heliar: 0 unidades. Abrir modelos' }).click();
  await page.getByLabel('Quantidade de HG38JD 24-320').fill('3');
  await page.getByRole('button', { name: 'Salvar Heliar' }).click();
  await expect(page.getByRole('heading', { name: 'Estoque do cliente' })).toBeVisible();
  // An empty outbox also exists before the save commits; observe the retry first.
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('visit-stock-sync-batches'))).toBe('2');
  await expect.poll(async () => (await offlineCounts(page)).events.length).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('same-visit-stock-batch'))).toBe('true');
  expect((await offlineCounts(page)).drafts).toMatchObject([{
    stock: { heliarQuantity: 3, completedOwnBrands: ['Heliar'], persistenceState: 'synced' },
  }]);
});

test('shows a definitive conflict without discarding the draft or retrying it', async ({ page }) => {
  await mockVisitSeller(page, 'conflict');
  await page.goto('/route');
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await startVisit(page);
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
  await startVisit(page);
  await expect(page.getByText('A sincronização será retomada quando a conexão voltar.', { exact: false })).toBeVisible();
  const visitUrl = page.url();
  const pending = await offlineCounts(page);
  expect(pending.events).toHaveLength(1);
  await page.evaluate(() => sessionStorage.setItem('visit-route-revised', 'true'));
  await context.setOffline(false);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
  await page.goto('/route');
  await expect(page.getByRole('heading', { name: 'Novo cliente da rota' })).toBeVisible();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  const savedVisits = page.getByRole('region', { name: 'Visitas salvas de outras versões' });
  await expect(savedVisits.getByRole('heading', { name: 'Cliente sintético da visita' })).toBeVisible();
  await expect(savedVisits.getByRole('button', { name: 'Iniciar visita' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('saved-visits-mobile.png'), fullPage: true });
  await savedVisits.getByRole('link', { name: 'Continuar visita' }).click();
  await expect(page).toHaveURL(visitUrl);
  await expect(page.getByText(protectedEvidenceMessage)).toBeVisible();
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
    await startVisit(page);
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
    await startVisit(page);
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
