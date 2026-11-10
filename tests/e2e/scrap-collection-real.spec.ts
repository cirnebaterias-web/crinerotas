import { expect, type Page } from '@playwright/test';
import { scrapCollectionsPath, scrapOperationsSchema, type LocalVisitDraft } from '@cirne/contracts';
import { test } from './real-route-fixture';

async function login(page: Page, actor: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(actor.email);
  await page.getByLabel('Senha', { exact: true }).fill(actor.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

// Read-only observation: the visit and every task must be created by the UI.
async function savedScrap(page: Page, offlineId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      const drafts = await new Promise<LocalVisitDraft[]>((resolve, reject) => {
        const reading = database.transaction('visitDrafts', 'readonly').objectStore('visitDrafts').getAll();
        reading.onsuccess = () => resolve(reading.result as LocalVisitDraft[]);
        reading.onerror = () => reject(reading.error);
      });
      const draft = drafts.find((value) => value.offlineId === id);
      return { canonicalVisitId: draft?.canonicalVisitId, scrap: draft?.scrap };
    } finally { database.close(); }
  }, offlineId);
}

test('seller collects scrap through a real visit and manager reads the verified receipt from Storage', async ({
  page, browser, request, baseURL, realRoute,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, realRoute.seller);
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole('link', { name: /^Rota/ }).click();
  await expect(page.getByText('Disponível offline neste aparelho.')).toBeVisible();
  await page.getByRole('button', { name: 'Iniciar visita', exact: true }).first().click();
  const checkin = page.getByRole('dialog', { name: 'Foto da fachada e posição', exact: true });
  await expect(checkin).toBeVisible();
  await expect(checkin.getByText('Câmera indisponível neste aparelho.', { exact: true })).toBeVisible();
  await expect(checkin.locator('.seller-evidence-location')).toHaveText('GPS indisponível');
  await expect(checkin.getByRole('status')).toHaveText('Existe uma exceção que precisa ser justificada.');
  await checkin.getByLabel('Justificativa obrigatória').fill('Câmera e GPS indisponíveis no teste sintético da coleta.');
  const confirmCheckin = checkin.getByRole('button', { name: 'Confirmar e iniciar visita', exact: true });
  await expect(confirmCheckin).toBeEnabled();
  await confirmCheckin.click();
  await expect(checkin).toHaveCount(0, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/visit\/[0-9a-f-]+\?step=start$/i);
  await expect(page.getByText('Registro da visita confirmado pelo servidor.')).toBeVisible();
  const visitOfflineId = new URL(page.url()).pathname.split('/').at(-1)!;

  await page.getByRole('button', { name: 'Coleta de estoque' }).click();
  for (const brand of ['Heliar', 'América', 'Durex', 'ACDelco']) {
    await page.getByRole('button', { name: `${brand}: 0 unidades. Abrir modelos`, exact: true }).click();
    await page.getByRole('checkbox', { name: `Confirmo que não há estoque de ${brand} neste PDV`, exact: true }).check();
    await page.getByRole('button', { name: `Salvar ${brand}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `${brand}: 0 unidades. Abrir modelos`, exact: true })).toContainText('Concluída');
  }
  await expect(page.getByText('4 de 4 marcas concluídas', { exact: true })).toBeVisible();
  const continueStock = page.getByRole('button', { name: 'Continuar para estoque da concorrência', exact: true });
  await expect(continueStock).toBeEnabled();
  await continueStock.click();
  await page.getByRole('checkbox', { name: 'Não há estoque da concorrência neste PDV', exact: true }).check();
  await page.getByRole('button', { name: 'Salvar concorrência e continuar', exact: true }).click();
  await page.getByRole('button', { name: 'Concluir coleta de estoque', exact: true }).click();
  await page.getByRole('button', { name: /Pesquisa de preços/ }).click();
  await page.getByRole('radio', { name: 'Preço não disponível', exact: true }).check();
  // Use a reason from the published real parameter set, not a fabricated identifier.
  const reason = page.getByRole('combobox', { name: 'Motivo da indisponibilidade', exact: true });
  await expect.poll(() => reason.locator('option').count()).toBeGreaterThan(1);
  await reason.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Salvar preços e continuar', exact: true }).click();
  await expect(page).toHaveURL(/\?step=actions$/);
  await expect(page.getByRole('button', { name: 'Salvar ações comerciais', exact: true })).toBeEnabled();
  for (const acknowledgement of await page.getByRole('checkbox', { name: 'Apresentei esta ação ao PDV', exact: true }).all()) {
    await acknowledgement.check();
  }
  await page.getByRole('radio', { name: 'Não identifiquei', exact: true }).check();
  await page.getByRole('button', { name: 'Salvar ações comerciais', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sucata', exact: true })).toBeVisible();

  const receiptNumber = `E2E-SUCATA-${crypto.randomUUID()}`;
  await page.getByRole('radio', { name: 'Coleta realizada pelo vendedor', exact: true }).check();
  await page.getByLabel('Peso coletado em kg', { exact: true }).fill('42,5');
  await page.getByLabel('Número do termo/canhoto', { exact: true }).fill(receiptNumber);
  await page.getByLabel(/^Destino previsto/u).selectOption('headquarters');
  await page.getByLabel('Cliente entregou a sucata e assinou o termo', { exact: true }).check();
  await page.getByLabel('Recebi a sucata e assinei como vendedor', { exact: true }).check();
  await page.getByLabel('Termo físico preenchido em duas vias', { exact: true }).check();
  await page.getByRole('button', { name: 'Salvar coleta', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ao menos uma foto legível' })).toBeVisible();
  await expect(page.getByLabel('Peso coletado em kg', { exact: true })).toHaveValue('42,5');
  await expect(page.getByLabel('Número do termo/canhoto', { exact: true })).toHaveValue(receiptNumber);

  const png = await page.evaluate((number) => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 600;
    const drawing = canvas.getContext('2d')!;
    drawing.fillStyle = 'white'; drawing.fillRect(0, 0, canvas.width, canvas.height);
    drawing.fillStyle = 'black'; drawing.font = '24px sans-serif';
    drawing.fillText('COMPROVANTE SINTÉTICO E2E — SEM COLETA REAL', 25, 70);
    drawing.fillText(number, 25, 140);
    drawing.fillText('Peso: 42,5 kg — duas vias', 25, 220);
    drawing.fillText('Cliente: assinatura sintética', 25, 320);
    drawing.fillText('Vendedor: assinatura sintética', 25, 420);
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, receiptNumber);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'termo-sintetico-e2e.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  });
  await expect(page.getByRole('img', { name: 'Fotografia do termo assinado', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Salvar coleta', exact: true }).click();
  await expect(page).toHaveURL(/\?step=review$/);
  await expect.poll(() => savedScrap(page, visitOfflineId), { timeout: 45_000 }).toMatchObject({
    canonicalVisitId: expect.any(String),
    scrap: { availability: 'collected', persistenceState: 'synced',
      collection: { actualWeightKg: '42.5', receiptNumber, destinationType: 'headquarters' } },
  });
  await expect(page.getByText(`Sucata: 42.5 kg coletados · termo ${receiptNumber}`, { exact: false }))
    .toContainText('Confirmada no servidor');

  const managerHeaders = { Authorization: `Bearer ${realRoute.manager.accessToken}` };
  const loadCollections = async () => {
    const response = await request.get(scrapCollectionsPath, { headers: managerHeaders });
    expect(response.status()).toBe(200);
    return scrapOperationsSchema.pick({ schemaVersion: true, collections: true, totals: true })
      .parse(await response.json()).collections.filter((item) => item.receiptNumber === receiptNumber);
  };
  await expect.poll(async () => (await loadCollections()).map((item) => ({
    weight: item.actualWeightKg, status: item.status, attachments: item.attachments.map((attachment) => attachment.status),
  })), { timeout: 45_000 }).toEqual([{ weight: '42.5', status: 'awaiting_receipt', attachments: ['verified'] }]);
  const [collection] = await loadCollections();
  expect(collection!.seller.id).toBe(realRoute.seller.id);
  expect(collection!.client.id).toBe(realRoute.clients[0]!.id);
  expect(collection!.receipt).toBeNull();
  expect(collection!.attachmentOfflineIds).toHaveLength(1);
  await page.reload();
  await expect(page.getByText(`Sucata: 42.5 kg coletados · termo ${receiptNumber}`, { exact: false }))
    .toContainText('Confirmada no servidor');
  expect(await loadCollections()).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Independent browser session proves manager authorization and private Storage retrieval.
  const managerContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const managerPage = await managerContext.newPage();
    await login(managerPage, realRoute.manager);
    await expect(managerPage).not.toHaveURL(/\/login(?:\?.*)?$/);
    await managerPage.goto('/management/scrap');
    const row = managerPage.getByRole('button', { name: new RegExp(receiptNumber) });
    await expect(row).toContainText('42.5 kg coletados');
    await row.click();
    await expect(managerPage.getByText('Aguardando conferência e confirmação da logística', { exact: true })).toBeVisible();
    await managerPage.getByRole('button', { name: 'Ver comprovantes assinados', exact: true }).click();
    const photo = managerPage.getByRole('img', { name: 'Comprovante assinado de entrega de sucata', exact: true });
    await expect(photo).toHaveCount(1);
    await expect.poll(() => photo.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))
      .toBe(true);
    const source = await photo.getAttribute('src');
    expect(source).toContain('/storage/v1/object/sign/scrap-evidence/');
    expect(await managerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await managerContext.close(); }
});
