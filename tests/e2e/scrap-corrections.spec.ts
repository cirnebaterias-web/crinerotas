import { expect, test, type Page } from '@playwright/test';
import type { MeResponse, ScrapCollection } from '@cirne/contracts';

const id = (value: number) => `62000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const identity: MeResponse = { id: id(1), displayName: 'Gestora sintética', roles: ['manager'], capabilities: ['identity.read_self', 'scrap.read_operations', 'scrap.manage_operations'], scopeIds: [], status: 'active' };
const point = { id: id(2), name: 'Ponto interior sintético', address: 'Rua de teste, 10 · Interior/RN' };
const initial: ScrapCollection = {
  id: id(3), offlineId: id(4), client: { id: id(5), name: 'Cliente interior sintético', address: 'Rua de teste, 20 · Interior/RN' },
  seller: { id: id(6), displayName: 'Vendedor interior sintético' }, actualWeightKg: '100', receiptNumber: 'TERMO-INTERIOR-001',
  collectedAt: '2026-10-06T09:45:32.789Z', serverSavedAt: '2026-10-06T09:46:00Z', destinationType: 'concentration_point', concentrationPoint: point,
  status: 'received', version: 2, attachmentOfflineIds: [id(7)], attachments: [{ offlineId: id(7), status: 'verified' }],
  receipt: { collectionId: id(3), receivedWeightKg: '98', receivedLocation: 'Matriz em Natal', observation: 'Conferência original da balança', receivedBy: { id: id(8), displayName: 'Logística sintética' }, receivedAt: '2026-10-06T11:00:00Z', version: 2 },
  retentionUntil: '2031-10-06T11:00:00Z',
};

async function mockOperations(page: Page, user: MeResponse, received = true) {
  await page.addInitScript(({ user, original, point, received }) => {
    let collection = structuredClone(original);
    if (!received) collection = { ...collection, receipt: null, version: 1, status: 'awaiting_receipt', retentionUntil: null };
    const revisions: unknown[] = []; const requests: Array<{ kind: string; method: string; body: Record<string, unknown>; key: string | null }> = [];
    const previous = window.fetch.bind(window);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === '/api/v1/me') return json(user);
      if (url.pathname === '/api/v1/scrap/collections') return json({ schemaVersion: 1, collections: [collection], totals: { collectedKg: collection.actualWeightKg, receivedKg: collection.receipt?.receivedWeightKg ?? '0', scheduledKg: '0' } });
      if (url.pathname === '/api/v1/scrap/schedules') return json({ schemaVersion: 1, schedules: [] });
      if (url.pathname === '/api/v1/scrap/points') return json({ schemaVersion: 1, points: [{ ...point, active: true, version: 1 }] });
      if (url.pathname.endsWith('/revisions')) return json({ schemaVersion: 1, revisions });
      if (url.pathname.endsWith('/attachments')) return json({ schemaVersion: 1, attachments: [{ offlineId: original.attachmentOfflineIds[0], signedUrl: `${location.origin}/synthetic-term.png` }] });
      if (url.pathname === `/api/v1/scrap/collections/${original.id}` && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)); const key = new Headers(init.headers).get('idempotency-key');
        requests.push({ kind: 'collection', method: 'PATCH', body, key }); sessionStorage.setItem('correction-requests', JSON.stringify(requests));
        if (requests.filter((request) => request.kind === 'collection').length === 1) {
          const before = { actualWeightKg: collection.actualWeightKg, receiptNumber: collection.receiptNumber, collectedAt: collection.collectedAt, version: collection.version };
          collection = { ...collection, actualWeightKg: body.actualWeightKg, receiptNumber: body.receiptNumber, collectedAt: body.collectedAt, version: collection.version + 1,
            receipt: collection.receipt ? { ...collection.receipt, observation: body.divergenceObservation ?? collection.receipt.observation } : null };
          revisions.push({ id: crypto.randomUUID(), kind: 'collection', actor: { id: user.id, displayName: user.displayName }, changedAt: new Date().toISOString(), reason: body.reason,
            before, after: { actualWeightKg: collection.actualWeightKg, receiptNumber: collection.receiptNumber, collectedAt: collection.collectedAt, version: collection.version } });
          throw new TypeError('Synthetic accepted correction response lost');
        }
        return json(collection);
      }
      if (url.pathname.endsWith('/receipt') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)); requests.push({ kind: 'receipt', method: 'PATCH', body, key: new Headers(init.headers).get('idempotency-key') }); sessionStorage.setItem('correction-requests', JSON.stringify(requests));
        const before = { receivedWeightKg: collection.receipt?.receivedWeightKg, receivedLocation: collection.receipt?.receivedLocation, observation: collection.receipt?.observation, version: collection.version };
        collection = { ...collection, version: collection.version + 1, receipt: { ...collection.receipt!, receivedWeightKg: body.receivedWeightKg, receivedLocation: body.receivedLocation, observation: body.observation ?? null, version: collection.version + 1 } };
        revisions.push({ id: crypto.randomUUID(), kind: 'receipt', actor: { id: user.id, displayName: user.displayName }, changedAt: new Date().toISOString(), reason: body.reason,
          before, after: { receivedWeightKg: collection.receipt?.receivedWeightKg, receivedLocation: collection.receipt?.receivedLocation, observation: collection.receipt?.observation, version: collection.version } });
        return json(collection.receipt);
      }
      if (url.pathname.endsWith('/receipt') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)); requests.push({ kind: 'receipt', method: 'POST', body, key: new Headers(init.headers).get('idempotency-key') }); sessionStorage.setItem('correction-requests', JSON.stringify(requests));
        collection = { ...collection, version: collection.version + 1, status: 'received', receipt: { collectionId: collection.id, receivedWeightKg: body.receivedWeightKg, receivedLocation: body.receivedLocation, observation: body.observation ?? null,
          receivedBy: { id: user.id, displayName: user.displayName }, receivedAt: new Date().toISOString(), version: collection.version + 1 } };
        return json(collection.receipt);
      }
      return previous(input, init);
    };
  }, { user, original: initial, point, received });
}

test.describe('scrap custody management', () => {
  test.use({ serviceWorkers: 'block' });
  test('manager corrections preserve the collection timestamp, retry key and before/after history', async ({ page }) => {
    await mockOperations(page, identity);
    await page.goto('/management/scrap');
    await page.getByRole('button', { name: /Cliente interior sintético · 100 kg coletados/ }).click();
    await page.getByRole('button', { name: 'Corrigir coleta', exact: true }).click();
    await page.getByLabel('Peso coletado corrigido em kg').fill('120');
    await page.getByLabel('Número do termo corrigido').fill('TERMO-INTERIOR-002');
    await page.getByLabel('Motivo da correção (obrigatório)').fill('Peso e número transcritos incorretamente do termo físico.');
    await page.getByRole('button', { name: 'Salvar correção auditada' }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('correction-requests'))).toBeNull();
    await page.getByLabel('Observação da conferência (obrigatória para divergência)').fill('Balança da matriz conferiu 98 kg; termo corrigido registra 120 kg.');
    await page.getByRole('button', { name: 'Salvar correção auditada' }).click();
    await expect(page.locator('.seller-app').getByRole('alert')).toContainText('Não foi possível confirmar a correção');
    await page.getByRole('button', { name: 'Salvar correção auditada' }).click();
    await expect(page.getByRole('button', { name: /Cliente interior sintético · 120 kg coletados/ })).toBeVisible();
    const history = page.getByRole('region', { name: 'Histórico de correções' });
    await expect(history.getByRole('heading', { name: 'Correção da coleta', exact: true })).toHaveCount(1);
    await expect(history).toContainText('TERMO-INTERIOR-001'); await expect(history).toContainText('TERMO-INTERIOR-002');
    const requests = await page.evaluate(() => JSON.parse(sessionStorage.getItem('correction-requests') ?? '[]') as Array<{ key: string; body: { expectedVersion: number; collectedAt: string } }>);
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]!.body.expectedVersion).toBe(2); expect(requests[0]!.body.collectedAt).toBe(initial.collectedAt);
    await page.getByRole('button', { name: 'Corrigir recebimento', exact: true }).click();
    await page.getByLabel('Peso recebido corrigido em kg').fill('119');
    await page.getByLabel('Local de recebimento corrigido').fill('Matriz em Natal · balança conferida');
    await page.getByLabel('Observação da conferência (obrigatória para divergência)').fill('Nova conferência registrada com diferença de 1 kg.');
    await page.getByLabel('Motivo da correção (obrigatório)').fill('Erro de digitação no peso recebido, comprovado na conferência.');
    await page.getByRole('button', { name: 'Salvar correção auditada' }).click();
    await expect(history.getByRole('heading', { name: 'Correção do recebimento', exact: true })).toHaveCount(1);
    await expect(history).toContainText('98'); await expect(history).toContainText('119');
    const all = await page.evaluate(() => JSON.parse(sessionStorage.getItem('correction-requests') ?? '[]') as Array<{ body: { expectedVersion: number } }>);
    expect(all[2]!.body.expectedVersion).toBe(3);
    await expect(page.getByText('Coletados pelo vendedor:', { exact: false })).toContainText('120 kg');
    await expect(page.getByText('Recebidos pela Cirne:', { exact: false })).toContainText('119 kg');
  });

  test('logistics receives the interior collection with term evidence and cannot perform manager corrections', async ({ page }) => {
    const logistics: MeResponse = { ...identity, id: id(8), displayName: 'Logística sintética', roles: ['logistics'], capabilities: ['identity.read_self', 'scrap.read_operations', 'scrap.receive'] };
    await mockOperations(page, logistics, false);
    await page.route('**/synthetic-term.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN2cAAAAASUVORK5CYII=', 'base64') }));
    await page.goto('/management/scrap');
    await page.getByRole('button', { name: /Cliente interior sintético · 100 kg coletados/ }).click();
    await expect(page.getByRole('button', { name: 'Corrigir coleta', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Corrigir recebimento', exact: true })).toHaveCount(0);
    await expect(page.getByText('TERMO-INTERIOR-001', { exact: true })).toBeVisible();
    await expect(page.getByText(`${point.name} · ${point.address}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ver comprovantes assinados' }).click();
    await expect(page.getByRole('img', { name: 'Comprovante assinado de entrega de sucata' })).toBeVisible();
    await page.getByLabel('Peso conferido em kg').fill('98');
    await page.getByLabel('Local do recebimento').fill('Matriz em Natal');
    await page.getByRole('button', { name: 'Confirmar recebimento pela Cirne' }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('correction-requests'))).toBeNull();
    await page.getByLabel('Observação (obrigatória para divergência)').fill('Diferença de 2 kg registrada na balança.');
    await page.getByRole('button', { name: 'Confirmar recebimento pela Cirne' }).click();
    await expect(page.getByRole('button', { name: /Cliente interior sintético · 100 kg coletados/ })).toContainText('Recebido pela Cirne');
    await expect(page.getByText('Coletados pelo vendedor:', { exact: false })).toContainText('100 kg');
    await expect(page.getByText('Recebidos pela Cirne:', { exact: false })).toContainText('98 kg');
    await expect(page.getByRole('button', { name: 'Confirmar recebimento pela Cirne' })).toHaveCount(0);
  });
});
