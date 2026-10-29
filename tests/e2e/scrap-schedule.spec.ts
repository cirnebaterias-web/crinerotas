import { expect, test, type Page } from '@playwright/test';
import type { MeResponse, ScrapClient } from '@cirne/contracts';

const client: ScrapClient = { id: '51000000-0000-4000-8000-000000000001', name: 'Cliente sucata sintético', address: 'Rua de teste, 15 · Natal/RN' };
const identity: MeResponse = { id: '51000000-0000-4000-8000-000000000002', displayName: 'Vendedor sucata sintético', roles: ['seller'], capabilities: ['identity.read_self', 'route.read_self', 'scrap.schedule_self'], scopeIds: [], status: 'active' };

async function setup(page: Page, user: MeResponse = identity) {
  await page.addInitScript(({ user, customer }) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => sessionStorage.getItem('scrap-offline') !== 'true' });
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/api/v1/me') return json(user);
      if (url.pathname === '/api/v1/commercial-actions') return json({ schemaVersion: 1, actions: [] });
      if (url.pathname === '/api/v1/scrap/points') return json({ schemaVersion: 1, points: [] });
      if (url.pathname === '/api/v1/parameter-sets/current') return new Response('{}', { status: 503 });
      if (url.pathname === '/api/v1/scrap/clients') return json({ schemaVersion: 1, clients: [customer] });
      if (url.pathname === '/api/v1/scrap/schedules' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { offlineId: string; estimatedWeightKg: string; desiredDate: string; period: string; observation: string; requestedAt: string };
        const headers = new Headers(init.headers);
        const attempts = JSON.parse(sessionStorage.getItem('scrap-attempts') ?? '[]') as unknown[];
        attempts.push({ body: payload, key: headers.get('idempotency-key'), device: headers.get('x-device-id') });
        sessionStorage.setItem('scrap-attempts', JSON.stringify(attempts));
        // The synthetic server accepted the first request; the browser lost its response.
        if (attempts.length === 1) throw new TypeError('Synthetic accepted response lost');
        return json({ id: '51000000-0000-4000-8000-000000000003', offlineId: payload.offlineId,
          client: customer, seller: { id: user.id, displayName: user.displayName }, origin: 'standalone', visitId: null,
          estimatedWeightKg: payload.estimatedWeightKg, desiredDate: payload.desiredDate, period: payload.period,
          observation: payload.observation, requestedAt: payload.requestedAt, serverSavedAt: new Date().toISOString(), status: 'pending', version: 1 });
      }
      return original(input, init);
    };
  }, { user, customer: client });
}

test.describe('standalone scrap scheduling', () => {
  test.use({ serviceWorkers: 'block' });
  test('restores offline scheduling and retries a lost response without creating duplicate volume', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    await page.goto('/home');
    await page.getByRole('link', { name: /^Agendar coleta de sucata/ }).click();
    await page.getByLabel('Buscar cliente').fill('sucata');
    await page.getByRole('button', { name: 'Buscar na base de clientes' }).click();
    await page.getByRole('button', { name: /Cliente sucata sintético/ }).click();
    await expect(page.getByText(`Endereço da base: ${client.address}`)).toBeVisible();
    await page.evaluate(() => { sessionStorage.setItem('scrap-offline', 'true'); window.dispatchEvent(new Event('offline')); });
    await page.getByLabel('Peso estimado em kg').fill('125,5');
    const future = new Date(); future.setDate(future.getDate() + 7);
    const date = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    await page.getByLabel('Data desejada').fill(date);
    await page.getByRole('radio', { name: 'Tarde', exact: true }).check();
    await page.getByLabel('Observação (opcional)').fill('Agendamento por telefone, cenário sintético.');
    await page.getByRole('button', { name: 'Salvar agendamento', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Salvo no aparelho · envio pendente' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('scrap-attempts'))).toBeNull();
    await page.reload();
    const history = page.getByRole('region', { name: 'Agendamentos salvos neste aparelho' });
    await expect(history.getByRole('heading', { name: client.name })).toHaveCount(1);
    await expect(history).toContainText('125.5 kg previstos');
    await expect(history).toContainText('Salvo no aparelho · envio pendente');
    await page.evaluate(() => { sessionStorage.removeItem('scrap-offline'); window.dispatchEvent(new Event('online')); });
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('scrap-attempts') ?? '[]').length as number)).toBe(1);
    await expect(history).toContainText('Salvo no aparelho · envio pendente');
    await page.getByRole('button', { name: 'Tentar sincronizar', exact: true }).click();
    await expect(history).toContainText('Confirmado no servidor');
    await expect(history.getByRole('heading', { name: client.name })).toHaveCount(1);
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('scrap-attempts') ?? '[]') as Array<{ key: string; device: string; body: unknown }>);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]);
    await page.reload();
    await expect(history).toContainText('Confirmado no servidor');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const answer of ['none', 'collected'] as const) {
  test(`visit requires an explicit scrap answer and preserves ${answer} on reopening`, async ({ page }) => {
    test.setTimeout(90_000);
    await setup(page);
    await page.goto('/scrap/schedule');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cirne-rotas.last-user-id'))).toBe(identity.id);
    const visitId = '51000000-0000-4000-8000-000000000010';
    await page.evaluate(async ({ user, customer, offlineId }) => {
      const deviceId = localStorage.getItem('cirne-rotas.device-id')!;
      const now = new Date().toISOString();
      const clientSnapshot = { ...customer, externalReference: null, latitude: null, longitude: null, portfolioReference: null };
      const stamp = { eventId: crypto.randomUUID(), deviceSavedAt: now, persistenceState: 'saved_on_device' };
      const draft = { schemaVersion: 1, userId: user.id, deviceId, offlineId, routeVersionStopId: '51000000-0000-4000-8000-000000000011',
        currentStep: 'scrap', deviceStartedAt: now, client: clientSnapshot, localStatus: 'draft', persistenceState: 'saved_on_device', updatedAt: now, lastConfirmedSequence: 4,
        stock: { heliarQuantity: 0, mouraQuantity: 0, ownLines: [], completedOwnBrands: ['Heliar', 'América', 'Durex', 'ACDelco'], competitorLines: [], ...stamp },
        prices: { availability: 'unavailable', unavailableReasonId: '51000000-0000-4000-8000-000000000012', ...stamp, eventId: crypto.randomUUID() },
        commercialActions: { ownAcknowledgements: [], competitor: { availability: 'not_identified' }, ...stamp, eventId: crypto.randomUUID() },
      };
      const bundle = { schemaVersion: 3, userId: user.id, deviceId, cachedAt: now,
        routeId: '51000000-0000-4000-8000-000000000013', routeVersionId: '51000000-0000-4000-8000-000000000014',
        versionNumber: 1, serviceDate: now.slice(0, 10), status: 'published', publishedAt: now, executionVersion: 1,
        seller: { id: user.id, displayName: user.displayName }, compositionChange: null,
        stops: [{ routeVersionStopId: draft.routeVersionStopId, plannedOrder: 1, executionOrder: 1, priority: 1, status: 'in_visit', executionVersion: 1, client: clientSnapshot }],
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('cirne-rotas-offline'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
      await new Promise<void>((resolve, reject) => { const tx = db.transaction(['visitDrafts', 'routeBundles', 'scrapPoints'], 'readwrite'); tx.objectStore('visitDrafts').put(draft); tx.objectStore('routeBundles').put(bundle);
        tx.objectStore('scrapPoints').put({ userId: user.id, deviceId, id: '51000000-0000-4000-8000-000000000015', name: 'Ponto interior sintético', address: 'Rua de teste, 10 · Interior/RN', active: true, version: 1, cachedAt: now });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      db.close(); sessionStorage.setItem('scrap-offline', 'true');
    }, { user: identity, customer: client, offlineId: visitId });
    await page.goto(`/visit/${visitId}?step=scrap`);
    await expect(page.getByRole('heading', { name: 'Sucata', exact: true })).toBeVisible({ timeout: 35_000 });
    await expect(page.getByRole('radio', { name: 'Sem sucata', exact: true })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Encerrar visita' })).toHaveCount(0);
    if (answer === 'none') {
      await page.getByRole('radio', { name: 'Sem sucata', exact: true }).check();
      await page.getByRole('button', { name: 'Confirmar sem sucata', exact: true }).click();
    } else {
      await page.getByRole('radio', { name: 'Coleta realizada pelo vendedor', exact: true }).check();
      await page.getByLabel('Peso coletado em kg').fill('100');
      await page.getByLabel('Número do termo/canhoto').fill('TERMO-INTERIOR-001');
      await page.getByLabel('Destino previsto').selectOption('concentration_point');
      await page.getByRole('combobox', { name: /^Ponto de concentração/ }).selectOption('51000000-0000-4000-8000-000000000015');
      await page.getByLabel('Cliente entregou a sucata e assinou o termo').check();
      await page.getByLabel('Recebi a sucata e assinei como vendedor').check();
      await page.getByLabel('Termo físico preenchido em duas vias').check();
      await page.getByRole('button', { name: 'Salvar coleta', exact: true }).click();
      await expect(page.locator('.seller-app').getByRole('alert')).toContainText('ao menos uma foto legível');
      const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500; const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 800, 500); ctx.fillStyle = 'black'; ctx.font = '30px sans-serif'; ctx.fillText('TERMO SINTETICO DE COLETA · 100 KG', 25, 80); ctx.fillText('Cliente: assinatura de teste', 25, 180); ctx.fillText('Vendedor: assinatura de teste', 25, 280); return canvas.toDataURL('image/png').split(',')[1]!; });
      await page.locator('input[type="file"]').setInputFiles({ name: 'termo-sintetico.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await expect(page.getByRole('img', { name: 'Fotografia do termo assinado' })).toBeVisible();
      await page.getByRole('button', { name: 'Salvar coleta', exact: true }).click();
    }
    await expect(page).toHaveURL(/\?step=review$/);
    const summary = answer === 'none' ? 'Sucata: Sem sucata' : '100 kg coletados · termo TERMO-INTERIOR-001';
    await expect(page.getByText(summary, { exact: false })).toBeVisible();
    await page.reload();
    await expect(page.getByText(summary, { exact: false })).toBeVisible({ timeout: 35_000 });
    const saved = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open('cirne-rotas-offline'); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
      const values = await new Promise<{ drafts: unknown[]; events: Array<{ operation: string }> }>((resolve, reject) => { const tx = db.transaction(['visitDrafts', 'outboxEvents']); const drafts = tx.objectStore('visitDrafts').getAll(); const events = tx.objectStore('outboxEvents').getAll(); tx.oncomplete = () => resolve({ drafts: drafts.result, events: events.result }); tx.onerror = () => reject(tx.error); }); db.close(); return values;
    });
    expect(saved.drafts).toMatchObject([{ scrap: { availability: answer, persistenceState: 'saved_on_device', ...(answer === 'collected' ? { collection: { actualWeightKg: '100', receiptNumber: 'TERMO-INTERIOR-001', destinationType: 'concentration_point', concentrationPointId: '51000000-0000-4000-8000-000000000015', attachmentOfflineIds: [expect.any(String)] } } : {}) }, currentStep: 'review' }]);
    expect(saved.events.filter((event) => event.operation === 'visit.scrap.saved.v1')).toHaveLength(1);
  });
  }

  test('management revises a pending schedule with a mandatory reason and stable retry key', async ({ page }) => {
    await page.addInitScript(({ customer, manager }) => {
      const previous = window.fetch.bind(window);
      const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + 7);
      const date = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
      const initial = { id: '51000000-0000-4000-8000-000000000020', offlineId: '51000000-0000-4000-8000-000000000021', client: customer,
        seller: { id: '51000000-0000-4000-8000-000000000002', displayName: 'Vendedor sucata sintético' }, origin: 'standalone', visitId: null,
        estimatedWeightKg: '100', desiredDate: date, period: 'morning', observation: 'Previsão original', requestedAt: new Date().toISOString(), serverSavedAt: new Date().toISOString(), status: 'pending', version: 1 };
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        if (url.pathname === '/api/v1/me') return json(manager);
        const stored = () => JSON.parse(sessionStorage.getItem('revised-schedule') ?? JSON.stringify(initial));
        if (url.pathname === '/api/v1/pickup-schedules' && !init?.method) return json({
          schemaVersion: 1,
          filters: {
            from: url.searchParams.get('from') ?? stored().desiredDate,
            to: url.searchParams.get('to') ?? stored().desiredDate,
            status: 'pending',
            ...(url.searchParams.get('period') ? { period: url.searchParams.get('period') } : {}),
          },
          generatedAt: new Date().toISOString(), lastServerConfirmedAt: stored().serverSavedAt,
          indicators: { records: 1, scheduledKg: stored().estimatedWeightKg }, records: [stored()], nextCursor: null,
          serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
        });
        if (url.pathname.endsWith(initial.id) && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)); const key = new Headers(init.headers).get('idempotency-key');
          const attempts = JSON.parse(sessionStorage.getItem('revision-attempts') ?? '[]'); attempts.push({ body, key }); sessionStorage.setItem('revision-attempts', JSON.stringify(attempts));
          if (attempts.length === 1) { sessionStorage.setItem('revised-schedule', JSON.stringify({ ...initial, estimatedWeightKg: body.estimatedWeightKg, desiredDate: body.desiredDate, period: body.period, observation: body.observation, version: 2 })); throw new TypeError('Synthetic accepted revision response lost'); }
          return json(stored());
        }
        return previous(input, init);
      };
    }, { customer: client, manager: { ...identity, roles: ['manager'], capabilities: ['identity.read_self', 'scrap.read_operations'] } });
    await page.goto('/management/scrap/agenda');
    await page.getByRole('button', { name: 'Atualizar agora' }).click();
    await page.getByRole('button', { name: 'Revisar agendamento', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Revisar agendamento · versão 1' })).toBeVisible();
    await page.getByLabel('Peso estimado revisado em kg').fill('120,5');
    await page.getByLabel('Período revisado').selectOption('afternoon');
    await page.getByRole('button', { name: 'Salvar revisão auditada' }).click();
    expect(await page.evaluate(() => sessionStorage.getItem('revision-attempts'))).toBeNull();
    await page.getByLabel('Motivo da revisão (obrigatório)').fill('Cliente solicitou alteração da previsão por telefone.');
    await page.getByRole('button', { name: 'Salvar revisão auditada' }).click();
    await expect(page.locator('.seller-app').getByRole('alert')).toContainText('Não foi possível confirmar');
    await page.getByRole('button', { name: 'Salvar revisão auditada' }).click();
    await expect(page.getByText('Revisão confirmada no servidor. O agendamento continua pendente.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Agendamentos pendentes' })).toContainText('Estado: Pendente · versão 2');
    await expect(page.getByRole('region', { name: 'Agendamentos pendentes' })).toContainText('120.5 kg estimados');
    const attempts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('revision-attempts') ?? '[]') as Array<{ body: { expectedVersion: number; reason: string }; key: string }>);
    expect(attempts).toHaveLength(2); expect(attempts[0]).toEqual(attempts[1]); expect(attempts[0]!.body.expectedVersion).toBe(1);
    expect(attempts[0]!.body.reason).toContain('Cliente solicitou');
  });
});
