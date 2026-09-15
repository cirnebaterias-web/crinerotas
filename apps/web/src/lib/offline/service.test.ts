import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mePath } from '@cirne/contracts';
import { createSyntheticRouteBundle, createValidatedLocalSession } from '@cirne/domain';
import { OfflineDatabase } from './database';
import { OfflineRepository } from './repository';
import { OfflineFoundationService, refreshBrowserSession } from './service';

const partition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const databaseNames: string[] = [];
const services: OfflineFoundationService[] = [];

function createLocalStorage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

async function setup(hostname = 'example.invalid') {
  const name = `offline-service-${crypto.randomUUID()}`;
  databaseNames.push(name);
  const database = new OfflineDatabase(name, { indexedDB, IDBKeyRange });
  const repository = new OfflineRepository(database);
  const at = '2026-09-11T12:00:00.000Z';
  await repository.saveValidatedRoute(
    createSyntheticRouteBundle(partition, at),
    createValidatedLocalSession(partition, at),
  );
  const localStorage = createLocalStorage({
    'cirne-rotas.device-id': partition.deviceId,
    'cirne-rotas.last-user-id': partition.userId,
  });
  vi.stubGlobal('window', {
    location: { hostname },
    localStorage,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal('navigator', { onLine: true });
  const service = new OfflineFoundationService(database, () => at);
  services.push(service);
  return {
    localStorage,
    repository,
    service,
  };
}

afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(databaseNames.splice(0).map((name) => (
    new Dexie(name, { indexedDB, IDBKeyRange }).delete()
  )));
});

describe('OfflineFoundationService online authorization', () => {
  it.each([401, 403])('invalidates local access after a definitive HTTP %s response', async (status) => {
    const { localStorage, repository, service } = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));

    await expect(service.initialize()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'authentication_required',
    });
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });

  it('keeps an already provisioned synthetic session only on loopback', async () => {
    const { localStorage, repository, service } = await setup('127.0.0.1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(service.initialize()).resolves.toMatchObject({
      kind: 'ready',
      partition,
    });
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBe(partition.userId);
    expect(await repository.getLocalSession(partition)).toBeDefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });

  it('invalidates local access when the online identity is not an active seller', async () => {
    const { localStorage, repository, service } = await setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: partition.userId,
        displayName: 'Vendedor sintético',
        roles: ['seller'],
        capabilities: ['route.read'],
        scopeIds: [],
        status: 'inactive',
      }),
    }));

    await expect(service.initialize()).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'authentication_required',
    });
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });
});

describe('refreshBrowserSession', () => {
  it('uses the same-origin identity endpoint so refreshed cookies can be persisted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshBrowserSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(mePath, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  });

  it('reports an unavailable refresh without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(refreshBrowserSession()).resolves.toBe(false);
  });
});
