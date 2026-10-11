import Dexie from 'dexie';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineDatabase } from './database';
import { StandaloneScrapScheduleStore } from './standalone-scrap';
import { OfflineRepository } from './repository';

const userId = '11111111-1111-4111-8111-111111111111';
const client = { id: '22222222-2222-4222-8222-222222222222', name: 'Loja Teste', address: 'Rua Um, Natal' };
const at = '2026-10-06T12:00:00.000Z';
const names: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(names.splice(0).map((name) => new Dexie(name, { indexedDB, IDBKeyRange }).delete()));
});

it('retains standalone schedules offline with a stable idempotency key and confirms them on reconnect', async () => {
  const name = `standalone-scrap-${crypto.randomUUID()}`;
  names.push(name);
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  const connection = { onLine: true };
  vi.stubGlobal('navigator', connection);
  const posts: Array<{ key: string; csrf: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/v1/me') return Response.json({
      id: userId, displayName: 'Vendedor', roles: ['seller'],
      capabilities: ['scrap.schedule_self'], scopeIds: [], status: 'active',
    });
    if (path.startsWith('/api/v1/scrap/clients')) return Response.json({ schemaVersion: 1, clients: [client] });
    if (path === '/api/v1/scrap/schedules') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ key: String((init?.headers as Record<string, string>)['Idempotency-Key']),
        csrf: String((init?.headers as Record<string, string>)['X-CSRF-Token']), body });
      return Response.json({
        id: '33333333-3333-4333-8333-333333333333', offlineId: body.offlineId,
        client, seller: { id: userId, displayName: 'Vendedor' }, origin: 'standalone', visitId: null,
        estimatedWeightKg: body.estimatedWeightKg, desiredDate: body.desiredDate,
        period: body.period, observation: body.observation ?? null, requestedAt: body.requestedAt,
        serverSavedAt: at, status: 'pending', version: 1,
      });
    }
    throw new Error(`Unexpected ${path}`);
  }));
  const first = new StandaloneScrapScheduleStore(new OfflineDatabase(name, { indexedDB, IDBKeyRange }), () => at);
  expect(await first.searchClients('Loja')).toEqual([client]);
  connection.onLine = false;
  expect(await first.searchClients('Loja')).toEqual([client]);
  const input = {
    offlineId: '44444444-4444-4444-8444-444444444444', estimatedWeightKg: '20',
    desiredDate: '2026-10-13', period: 'morning' as const, requestedAt: at,
  };
  const pending = await first.enqueue(client, input);
  expect(pending.status).toBe('pending');
  expect((await first.enqueue(client, input)).idempotencyKey).toBe(pending.idempotencyKey);
  first.close();
  const reopened = new StandaloneScrapScheduleStore(new OfflineDatabase(name, { indexedDB, IDBKeyRange }), () => at);
  expect((await reopened.listSchedules())[0]).toMatchObject({ status: 'pending', offlineId: input.offlineId });
  connection.onLine = true;
  expect((await reopened.synchronize())[0]).toMatchObject({ status: 'synced', serverId: '33333333-3333-4333-8333-333333333333' });
  expect(posts).toHaveLength(1);
  expect(posts[0]?.key).toBe(pending.idempotencyKey);
  expect(posts[0]?.csrf).toBe('cirne-route-v1');
  expect(posts[0]?.body.offlineId).toBe(input.offlineId);
  reopened.close();
});

it('keeps concentration points partitioned and available to an offline visit', async () => {
  const name = `scrap-points-${crypto.randomUUID()}`;
  names.push(name);
  const repository = new OfflineRepository(new OfflineDatabase(name, { indexedDB, IDBKeyRange }));
  await repository.open();
  const point = { id: '55555555-5555-4555-8555-555555555555', name: 'Ponto Interior',
    address: 'Rua Dois', active: true, version: 1 };
  const seller = { userId, deviceId: '66666666-6666-4666-8666-666666666666' };
  await repository.cacheScrapPoints(seller, [point], at);
  expect(await repository.listScrapPoints(seller)).toEqual([point]);
  expect(await repository.listScrapPoints({ ...seller, userId: '77777777-7777-4777-8777-777777777777' }))
    .toEqual([]);
  repository.close();
});
