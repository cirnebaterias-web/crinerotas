import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mePath, type CanonicalRoute } from '@cirne/contracts';
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

function canonicalRoute(userId = partition.userId): CanonicalRoute {
  return {
    schemaVersion: 2,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 2,
    serviceDate: '2026-09-11',
    status: 'published',
    publishedAt: '2026-09-11T11:00:00.000Z',
    executionVersion: 2,
    seller: { id: userId, displayName: 'Vendedor sintético' },
    stops: [{
      routeVersionStopId: '55555555-5555-4555-8555-555555555555',
      plannedOrder: 1,
      executionOrder: 1,
      priority: 1,
      status: 'pending',
      executionVersion: 2,
      client: {
        id: '66666666-6666-4666-8666-666666666666',
        externalReference: 'SYN-01',
        name: 'Cliente sintético',
        address: 'Endereço sintético',
        latitude: null,
        longitude: null,
        portfolioReference: null,
      },
    }],
  };
}

function revisedCanonicalRoute(userId = partition.userId): CanonicalRoute {
  const previous = canonicalRoute(userId);
  return {
    ...previous,
    schemaVersion: 3,
    routeVersionId: '44444444-4444-4444-8444-444444444445',
    versionNumber: 3,
    executionVersion: 4,
    compositionChange: {
      reason: 'Cliente redistribuido entre carteiras',
      previousVersionNumber: 2,
      added: [{ id: '77777777-7777-4777-8777-777777777777', name: 'Cliente novo' }],
      removed: [{ id: previous.stops[0]!.client.id, name: previous.stops[0]!.client.name }],
    },
  };
}

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
    database,
    localStorage,
    repository,
    service,
  };
}

afterEach(async () => {
  services.splice(0).forEach((service) => service.close());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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

  it('revokes the previous seller when an online identity changes', async () => {
    const { localStorage, repository, service } = await setup();
    const nextUser = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: nextUser,
        displayName: 'Vendedor B sintético',
        roles: ['seller'],
        capabilities: ['route.read_self'],
        scopeIds: [],
        status: 'active',
      }),
    }));

    await expect(service.initialize()).resolves.toMatchObject({
      kind: 'ready',
      partition: { userId: nextUser, deviceId: partition.deviceId },
    });
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBe(nextUser);
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });

  it('removes the previous user pointer before an identity-switch deletion can fail', async () => {
    const { localStorage, service } = await setup();
    const serviceRepository = Reflect.get(service, 'repository') as OfflineRepository;
    vi.spyOn(serviceRepository, 'deleteLocalSession').mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Vendedor B sintético',
        roles: ['seller'],
        capabilities: ['route.read_self'],
        scopeIds: [],
        status: 'active',
      }),
    }));

    await expect(service.initialize()).resolves.toMatchObject({ kind: 'empty' });
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
  });
});

describe('canonical route cache', () => {
  it('commits a canonical route and session but reports unavailable without a verified worker', async () => {
    const { repository, service } = await setup();

    await expect(service.cacheCanonicalRoute(partition.userId, canonicalRoute())).resolves.toMatchObject({
      bundle: { schemaVersion: 2, routeVersionId: '44444444-4444-4444-8444-444444444444' },
      workerReady: false,
      availableOffline: false,
      compositionUpdated: false,
    });
    expect(await repository.listRouteBundles(partition)).toMatchObject([{
      schemaVersion: 2,
      routeId: '33333333-3333-4333-8333-333333333333',
    }]);
  });

  it('reports a composition update only after a newer version replaces the local cache', async () => {
    const { repository, service } = await setup();
    await service.cacheCanonicalRoute(partition.userId, canonicalRoute());

    await expect(service.cacheCanonicalRoute(partition.userId, revisedCanonicalRoute()))
      .resolves.toMatchObject({
        bundle: { schemaVersion: 3, versionNumber: 3 },
        compositionUpdated: true,
      });
    await expect(service.cacheCanonicalRoute(partition.userId, revisedCanonicalRoute()))
      .resolves.toMatchObject({ compositionUpdated: false });
    expect(await repository.listRouteBundles(partition)).toMatchObject([{
      schemaVersion: 3,
      versionNumber: 3,
      compositionChange: { reason: 'Cliente redistribuido entre carteiras' },
    }]);
  });

  it('preserves the previous snapshot and session when the atomic commit fails', async () => {
    const { database, repository, service } = await setup();
    const previousSession = await repository.getLocalSession(partition);
    vi.spyOn(database.routeBundles, 'put').mockRejectedValueOnce(
      new DOMException('Storage full', 'QuotaExceededError'),
    );

    await expect(service.cacheCanonicalRoute(partition.userId, canonicalRoute()))
      .rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.listRouteBundles(partition)).toMatchObject([{ schemaVersion: 1 }]);
    expect(await repository.getLocalSession(partition)).toEqual(previousSession);
  });

  it('revokes local access without deleting the cached route', async () => {
    const { localStorage, repository, service } = await setup();
    await service.revokeLocalAccess(partition.userId);

    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });

  it('deletes the local session even when the user pointer cannot be removed', async () => {
    const { localStorage, repository, service } = await setup();
    vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    await expect(service.revokeLocalAccess(partition.userId))
      .rejects.toMatchObject({ name: 'SecurityError' });
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });

  it('cancels an in-flight cache before commit and blocks new writes during revocation', async () => {
    const { localStorage, repository, service } = await setup();
    let releaseWorker: ((registration: { active: { postMessage: (message: unknown, ports: MessagePort[]) => void } }) => void) | undefined;
    let readyRequested = false;
    const workerReady = new Promise<{ active: { postMessage: (message: unknown, ports: MessagePort[]) => void } }>((resolve) => {
      releaseWorker = resolve;
    });
    vi.stubEnv('NEXT_PUBLIC_OFFLINE_REVISION', 'test-revision');
    vi.stubGlobal('navigator', {
      onLine: true,
      serviceWorker: {
        get ready() { readyRequested = true; return workerReady; },
        getRegistration: async () => undefined,
      },
      storage: { persist: async () => false, persisted: async () => false },
    });

    const cache = service.cacheCanonicalRoute(partition.userId, canonicalRoute());
    await vi.waitFor(() => expect(readyRequested).toBe(true));
    const revoke = service.revokeLocalAccess(partition.userId);
    await expect(service.cacheCanonicalRoute(partition.userId, canonicalRoute()))
      .rejects.toThrow('O acesso local está sendo revogado.');
    releaseWorker?.({
      active: {
        postMessage: (_message, ports) => ports[0]?.postMessage({
          type: 'cirne-rotas:offline-revision-response',
          revision: 'test-revision',
        }),
      },
    });
    await expect(cache).rejects.toThrow('O acesso local foi revogado.');
    await revoke;

    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.listRouteBundles(partition)).toMatchObject([{ schemaVersion: 1 }]);
  });

  it('removes a session written while local revocation is waiting for persistence', async () => {
    const { localStorage, repository, service } = await setup();
    const serviceRepository = Reflect.get(service, 'repository') as OfflineRepository;
    const originalSave = serviceRepository.saveValidatedRoute.bind(serviceRepository);
    let reportSaved: (() => void) | undefined;
    let releaseSave: (() => void) | undefined;
    const saved = new Promise<void>((resolve) => { reportSaved = resolve; });
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    vi.spyOn(serviceRepository, 'saveValidatedRoute').mockImplementationOnce(async (bundle, session) => {
      const stored = await originalSave(bundle, session);
      reportSaved?.();
      await saveGate;
      return stored;
    });

    const cache = service.cacheCanonicalRoute(partition.userId, canonicalRoute());
    await saved;
    const revoke = service.revokeLocalAccess(partition.userId);
    releaseSave?.();

    await expect(cache).rejects.toThrow('O acesso local foi revogado.');
    await expect(revoke).resolves.toBeUndefined();
    expect(localStorage.getItem('cirne-rotas.last-user-id')).toBeNull();
    expect(await repository.getLocalSession(partition)).toBeUndefined();
  });

  it('keeps the newest canonical version when concurrent cache writes finish in reverse order', async () => {
    const { repository, service } = await setup();
    const serviceRepository = Reflect.get(service, 'repository') as OfflineRepository;
    const originalSave = serviceRepository.saveValidatedRoute.bind(serviceRepository);
    let releaseOlder: (() => void) | undefined;
    const olderGate = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const save = vi.spyOn(serviceRepository, 'saveValidatedRoute').mockImplementationOnce(async (bundle, session) => {
      await olderGate;
      return originalSave(bundle, session);
    });
    const olderRoute = { ...canonicalRoute(), versionNumber: 1, executionVersion: 1 };
    const newerRoute = { ...canonicalRoute(), versionNumber: 2, executionVersion: 3 };

    const olderWrite = service.cacheCanonicalRoute(partition.userId, olderRoute);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    const newerResult = await service.cacheCanonicalRoute(partition.userId, newerRoute);
    releaseOlder?.();
    const olderResult = await olderWrite;

    expect(newerResult.bundle.executionVersion).toBe(3);
    expect(olderResult.bundle.executionVersion).toBe(3);
    expect(await repository.listRouteBundles(partition)).toMatchObject([{
      schemaVersion: 2,
      versionNumber: 2,
      executionVersion: 3,
    }]);
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
