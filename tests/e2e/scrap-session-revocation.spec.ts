import { expect, test, type Page } from '@playwright/test';
import { scrapAgendaResponseSchema, scrapCollectionSchema, type MeResponse } from '@cirne/contracts';

const manager: MeResponse = {
  id: '41600000-0000-4000-8000-000000000101', displayName: 'Gestor sintético da sucata',
  roles: ['manager'], status: 'active', scopeIds: [], capabilities: ['scrap.read_operations'],
};
const collection = scrapCollectionSchema.parse({
  id: '41600000-0000-4000-8000-000000000102', offlineId: '41600000-0000-4000-8000-000000000103',
  client: { id: '41600000-0000-4000-8000-000000000104', name: 'Cliente privado da operação', address: 'Rua sintética da operação, 104' },
  seller: { id: '41600000-0000-4000-8000-000000000105', displayName: 'Vendedor sintético da operação' },
  actualWeightKg: '42.50', receiptNumber: 'TERMO-SINTETICO-104',
  collectedAt: '2026-10-28T10:00:00.000Z', serverSavedAt: '2026-10-28T10:00:01.000Z',
  destinationType: 'headquarters', concentrationPoint: null, status: 'awaiting_receipt', version: 1,
  attachmentOfflineIds: ['41600000-0000-4000-8000-000000000106'],
  attachments: [{ offlineId: '41600000-0000-4000-8000-000000000106', status: 'verified' }],
  receipt: null, retentionUntil: null,
});
const lateCollection = scrapCollectionSchema.parse({
  ...collection, client: { ...collection.client, name: 'Cliente tardio da operação', address: 'Endereço tardio da operação' },
  actualWeightKg: '98.70', receiptNumber: 'TERMO-TARDIO-104',
});
const agenda = scrapAgendaResponseSchema.parse({
  schemaVersion: 1,
  filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending', period: 'morning' },
  generatedAt: '2026-10-28T12:00:00.000Z', lastServerConfirmedAt: '2026-10-28T10:00:01.000Z',
  indicators: { records: 1, scheduledKg: '42.50' }, nextCursor: null,
  serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  records: [{
    id: '41600000-0000-4000-8000-000000000107', offlineId: '41600000-0000-4000-8000-000000000108',
    client: { ...collection.client, name: 'Cliente privado da agenda', address: 'Rua sintética da agenda, 104' },
    seller: collection.seller, origin: 'standalone', visitId: null,
    estimatedWeightKg: '42.50', desiredDate: '2026-10-30', period: 'morning',
    observation: 'Observação privada sintética da agenda', requestedAt: '2026-10-28T10:00:00.000Z',
    serverSavedAt: '2026-10-28T10:00:01.000Z', status: 'pending', version: 1,
  }],
});
const lateAgenda = scrapAgendaResponseSchema.parse({
  ...agenda, indicators: { records: 1, scheduledKg: '98.70' },
  records: [{ ...agenda.records[0],
    client: { ...collection.client, name: 'Cliente tardio da agenda', address: 'Endereço tardio da agenda' },
    estimatedWeightKg: '98.70', observation: 'Observação tardia da agenda',
  }],
});

type PendingRequest = {
  hold: boolean;
  pending: boolean;
  consumed: boolean;
  requests: number;
  release: (() => void) | null;
};

async function installFetchFixture(page: Page, path: string, initial: unknown, late: unknown) {
  // Only browser requests are stubbed: the agenda's server-side initial auth remains denied.
  await page.addInitScript(({ identity, path, initial, late }) => {
    const originalFetch = window.fetch.bind(window);
    const state: PendingRequest = { hold: false, pending: false, consumed: false, requests: 0, release: null };
    Reflect.set(window, '__scrapRevocationRequest', state);
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/v1/me') return json(identity);
      if (url.pathname === path) {
        state.requests += 1;
        if (!state.hold) return json(initial);
        state.pending = true;
        // Deliberately ignore cancellation: a stale successful response must still be fenced.
        return new Promise<Response>((resolve) => {
          state.release = () => {
            const response = json(late);
            const readJson = response.json.bind(response);
            response.json = async () => {
              const payload: unknown = await readJson();
              state.consumed = true;
              return payload;
            };
            resolve(response);
          };
        });
      }
      if (url.pathname.endsWith('/revisions')) return json({ schemaVersion: 1, revisions: [] });
      if (url.pathname.startsWith('/api/v1/')) return new Response('{}', { status: 503 });
      return originalFetch(input, options);
    };
  }, { identity: manager, path, initial, late });
}

async function holdNextRequest(page: Page) {
  await page.evaluate(() => {
    (Reflect.get(window, '__scrapRevocationRequest') as PendingRequest).hold = true;
  });
}

async function expectPendingRequest(page: Page) {
  await expect.poll(() => page.evaluate(() =>
    (Reflect.get(window, '__scrapRevocationRequest') as PendingRequest).pending)).toBe(true);
}

async function releasePendingRequest(page: Page) {
  await page.evaluate(() => {
    const request = Reflect.get(window, '__scrapRevocationRequest') as PendingRequest;
    if (!request.release) throw new Error('Expected a pending synthetic request.');
    request.release();
  });
  await expect.poll(() => page.evaluate(() =>
    (Reflect.get(window, '__scrapRevocationRequest') as PendingRequest).consumed)).toBe(true);
  // Allow the resolved fetch, JSON parsing and React render to settle before negative assertions.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test.describe('manager scrap session revocation', () => {
  test.use({ serviceWorkers: 'block' });

  test('clears collection details and totals on broadcast and rejects a late refresh', async ({ page }) => {
    await installFetchFixture(page, '/api/v1/scrap/collections',
      { collections: [collection], totals: { collectedKg: '42.50', receivedKg: '0', scheduledKg: '18.00' } },
      { collections: [lateCollection], totals: { collectedKg: '98.70', receivedKg: '0', scheduledKg: '76.00' } });
    await page.goto('/management/scrap');
    await page.getByRole('button', { name: new RegExp(collection.client.name) }).click();
    await expect(page.getByRole('heading', { name: collection.client.name, exact: true })).toBeVisible();
    await expect(page.getByText(collection.client.address, { exact: true })).toBeVisible();
    const volumes = page.getByRole('region', { name: 'Volumes separados' });
    await expect(volumes).toContainText('42.50 kg');
    await expect(volumes).toContainText('18.00 kg previstos');

    await holdNextRequest(page);
    await page.getByRole('button', { name: 'Atualizar', exact: true }).click();
    await expectPendingRequest(page);
    await page.evaluate(() => {
      const channel = new BroadcastChannel('cirne-session');
      channel.postMessage('changed');
      channel.close();
    });
    const revoked = page.getByRole('alert').filter({ hasText: 'A sessão mudou.' });
    await expect(revoked).toContainText('Entre novamente para consultar a operação.');
    await expect(page.getByText(collection.client.address, { exact: true })).toHaveCount(0);
    await expect(volumes.locator('strong')).toHaveText(['0 kg', '0 kg', '0 kg previstos']);

    await releasePendingRequest(page);
    for (const privateText of [collection.client.name, collection.client.address, collection.receiptNumber,
      lateCollection.client.name, lateCollection.client.address, lateCollection.receiptNumber]) {
      await expect(page.locator('body')).not.toContainText(privateText);
    }
    await expect(volumes.locator('strong')).toHaveText(['0 kg', '0 kg', '0 kg previstos']);
    await expect(revoked).toBeVisible();
    await expect(page.getByRole('button', { name: 'Atualizar', exact: true })).toBeDisabled();
  });

  test('clears agenda records and filters on storage revocation and rejects a late refresh', async ({ page }) => {
    const [initialRecord] = agenda.records;
    const [lateRecord] = lateAgenda.records;
    if (!initialRecord || !lateRecord || initialRecord.observation === null || lateRecord.observation === null) {
      throw new Error('Expected both synthetic agenda fixtures to include a record and observation.');
    }
    await installFetchFixture(page, '/api/v1/pickup-schedules', agenda, lateAgenda);
    await page.goto('/management/scrap/agenda?from=2026-10-26&to=2026-11-01&period=morning');
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expect(page.getByRole('heading', { name: initialRecord.client.name, exact: true })).toBeVisible();
    await expect(page.getByText(initialRecord.observation, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Indicadores da agenda' })).toContainText('42.50');
    await page.getByLabel('Vendedor (ID)', { exact: true }).fill(collection.seller.id);
    await page.getByLabel('Cliente (ID)', { exact: true }).fill(collection.client.id);

    await holdNextRequest(page);
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    await expectPendingRequest(page);
    await page.evaluate((userId) => window.dispatchEvent(new StorageEvent('storage', {
      key: 'cirne-rotas.last-user-id', oldValue: userId, newValue: null, storageArea: localStorage,
    })), manager.id);
    const revoked = page.getByRole('alert').filter({ hasText: 'A sessão mudou.' });
    await expect(revoked).toContainText('Entre novamente para consultar a agenda.');
    await expect(page.getByRole('region', { name: 'Indicadores da agenda' })).toHaveCount(0);
    await expect(page.getByLabel('Vendedor (ID)', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Cliente (ID)', { exact: true })).toHaveValue('');

    await releasePendingRequest(page);
    for (const privateText of [initialRecord.client.name, initialRecord.client.address,
      initialRecord.observation, lateRecord.client.name, lateRecord.client.address,
      lateRecord.observation, '42.50', '98.70']) {
      await expect(page.locator('body')).not.toContainText(privateText);
    }
    await expect(page.getByRole('region', { name: 'Indicadores da agenda' })).toHaveCount(0);
    await expect(revoked).toBeVisible();
    await page.getByRole('button', { name: 'Atualizar agora', exact: true }).click();
    expect(await page.evaluate(() => (Reflect.get(window, '__scrapRevocationRequest') as PendingRequest).requests)).toBe(2);
    await expect(revoked).toBeVisible();
  });
});
