import { expect, test } from '@playwright/test';

const syntheticSellerId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const routeId = '33333333-3333-4333-8333-333333333333';
const stopId = '44444444-4444-4444-8444-444444444441';

test('installs the generic shell and reopens route, draft, and outbox offline', async ({ page, context }) => {
  await page.goto('/demo/offline');
  await expect(page.getByRole('heading', { name: 'Rota de campo' })).toBeVisible();
  await page.getByRole('button', { name: 'Carregar rota sintética local' }).click();
  await expect(page.getByText('Disponível offline', { exact: true })).toBeVisible();
  const workerRevision = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (!worker) return null;
    return new Promise<unknown>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      worker.postMessage({ type: 'cirne-rotas:offline-revision-request' }, [channel.port2]);
    });
  });
  expect(workerRevision).toMatchObject({
    type: 'cirne-rotas:offline-revision-response',
    revision: expect.stringMatching(/^[a-f0-9]{16}$/),
  });
  await page.getByRole('button', { name: 'Iniciar rascunho local' }).click();
  await expect(page.getByText('Rascunho salvo no aparelho.')).toBeVisible();
  await expect(page.getByText('1 evento(s)')).toBeVisible();

  const privateMarker = `runtime-private-${crypto.randomUUID()}`;
  await page.evaluate(async (marker) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('routeBundles', 'readwrite');
      const store = tx.objectStore('routeBundles');
      const read = store.getAll();
      read.onsuccess = () => {
        const bundle = read.result[0];
        if (!bundle) {
          tx.abort();
          return;
        }
        bundle.stops[0].displayLabel = marker;
        store.put(bundle);
      };
      read.onerror = () => reject(read.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Route bundle mutation aborted.'));
    });
    database.close();
  }, privateMarker);
  await page.reload();
  await expect(page.getByText(privateMarker)).toBeVisible();

  const cached = await page.evaluate(async () => {
    const entries: { url: string; body: string }[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({ url: request.url, body: response ? await response.clone().text() : '' });
      }
    }
    return entries;
  });
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.some(({ url }) => {
    const pathname = new URL(url).pathname;
    return pathname.startsWith('/api/v1/') || pathname.startsWith('/management/') || pathname.startsWith('/auth/') || pathname === '/route';
  })).toBe(false);
  const cachedBodies = cached.map(({ body }) => body).join('\n');
  expect(cachedBodies).not.toContain(privateMarker);
  expect(cachedBodies).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
  expect(cachedBodies).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Rota de campo' })).toBeVisible();
  await expect(page.getByText('Disponível offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Rascunho salvo no aparelho.')).toBeVisible();
  await expect(page.getByText('1 evento(s)')).toBeVisible();

  await page.goto('/demo/offline/visit/55555555-5555-4555-8555-555555555555?step=start', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Disponível offline', { exact: true })).toBeVisible();
});

test('does not claim a saved draft after quota failure and safely retries the same command', async ({ page }) => {
  await page.goto('/demo/offline');
  await page.getByRole('button', { name: 'Carregar rota sintética local' }).click();
  await expect(page.getByText('Disponível offline', { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function addWithOneQuotaFailure(value: unknown, key?: IDBValidKey) {
      if (this.name === 'outboxEvents') {
        IDBObjectStore.prototype.add = originalAdd;
        throw new DOMException('Storage full', 'QuotaExceededError');
      }
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
    };
  });

  await page.getByRole('button', { name: 'Iniciar rascunho local' }).click();
  await expect(page.getByText('Espaço insuficiente: nada foi confirmado como salvo.')).toBeVisible();
  await expect(page.getByText('Rascunho salvo no aparelho.')).toHaveCount(0);
  await expect(page.getByText('0 evento(s)')).toBeVisible();

  await page.getByRole('button', { name: 'Iniciar rascunho local' }).click();
  await expect(page.getByText('Rascunho salvo no aparelho.')).toBeVisible();
  await expect(page.getByText('1 evento(s)')).toBeVisible();
});

test('upgrades an existing browser database from v1 to v5 without deleting durable records', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async ({ syntheticSellerId, deviceId, routeId, stopId }) => {
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase('cirne-rotas-offline');
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      // Dexie maps its logical versions to native IndexedDB versions by a factor of 10.
      const opening = indexedDB.open('cirne-rotas-offline', 10);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        const routes = db.createObjectStore('routeBundles', { keyPath: ['userId', 'deviceId', 'routeId'] });
        routes.createIndex('[userId+deviceId]', ['userId', 'deviceId']);
        routes.createIndex('userId', 'userId');
        routes.createIndex('deviceId', 'deviceId');
        routes.createIndex('cachedAt', 'cachedAt');
        const drafts = db.createObjectStore('visitDrafts', { keyPath: ['userId', 'deviceId', 'offlineId'] });
        drafts.createIndex('[userId+deviceId]', ['userId', 'deviceId']);
        drafts.createIndex('[userId+deviceId+routeVersionStopId]', ['userId', 'deviceId', 'routeVersionStopId']);
        drafts.createIndex('updatedAt', 'updatedAt');
        const events = db.createObjectStore('outboxEvents', { keyPath: ['userId', 'deviceId', 'eventId'] });
        events.createIndex('[userId+deviceId+idempotencyKey]', ['userId', 'deviceId', 'idempotencyKey'], { unique: true });
        events.createIndex('[userId+deviceId+aggregateId+sequence]', ['userId', 'deviceId', 'aggregateId', 'sequence'], { unique: true });
        events.createIndex('[userId+deviceId]', ['userId', 'deviceId']);
        events.createIndex('status', 'status');
        events.createIndex('occurredAt', 'occurredAt');
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(['routeBundles', 'visitDrafts', 'outboxEvents'], 'readwrite');
      tx.objectStore('routeBundles').put({
        schemaVersion: 1, userId: syntheticSellerId, deviceId, routeId, routeVersion: 1, parameterSetVersion: 1,
        serviceDate: '2026-09-11', cachedAt: '2026-09-11T12:00:00.000Z',
        stops: [{ routeVersionStopId: stopId, displayLabel: 'Parada sintética 01', executionOrder: 1, priority: 1 }],
      });
      tx.objectStore('visitDrafts').put({
        schemaVersion: 1, userId: syntheticSellerId, deviceId, offlineId: '55555555-5555-4555-8555-555555555555',
        routeVersionStopId: stopId, currentStep: 'start', acknowledged: true, localStatus: 'draft',
        persistenceState: 'saved_on_device', updatedAt: '2026-09-11T12:01:00.000Z',
      });
      tx.objectStore('outboxEvents').put({
        schemaVersion: 1, userId: syntheticSellerId, deviceId, eventId: '66666666-6666-4666-8666-666666666666',
        idempotencyKey: '77777777-7777-4777-8777-777777777777', operation: 'visit.draft.saved',
        aggregateId: '55555555-5555-4555-8555-555555555555', sequence: 1,
        payload: { draftOfflineId: '55555555-5555-4555-8555-555555555555', routeVersionStopId: stopId, acknowledged: true },
        status: 'pending', attemptCount: 0, occurredAt: '2026-09-11T12:01:00.000Z',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    localStorage.setItem('cirne-rotas.device-id', deviceId);
    localStorage.setItem('cirne-rotas.last-user-id', syntheticSellerId);
  }, { syntheticSellerId, deviceId, routeId, stopId });

  await page.goto('/demo/offline');
  await expect(page.getByText('Acesso local bloqueado')).toBeVisible();
  const migrated = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('cirne-rotas-offline');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const counts = await Promise.all(['routeBundles', 'visitDrafts', 'outboxEvents'].map((storeName) => new Promise<number>((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    const logicalVersion = database.version / 10;
    const hasSessions = database.objectStoreNames.contains('localSessions');
    database.close();
    return { logicalVersion, hasSessions, counts };
  });
  expect(migrated).toEqual({ logicalVersion: 5, hasSessions: true, counts: [1, 1, 1] });
});
