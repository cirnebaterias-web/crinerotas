import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticRouteBundle, createValidatedLocalSession } from '@cirne/domain';
import { OfflineDatabase } from './database';
import { OfflineRepository } from './repository';
import { OfflineFoundationService } from './service';

const partition = {
  userId: '33333333-3333-4333-8333-333333333331',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const otherPartition = { ...partition, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const now = '2026-09-17T12:00:00.000Z';
const databases: OfflineDatabase[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(online = false) {
  const values = new Map([
    ['cirne-rotas.device-id', partition.deviceId],
    ['cirne-rotas.last-user-id', partition.userId],
  ]);
  vi.stubGlobal('window', {
    location: { hostname: '127.0.0.1' },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  vi.stubGlobal('navigator', { onLine: online });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    id: partition.userId, displayName: 'Vendedor sintético', roles: ['seller'],
    capabilities: ['identity.read_self', 'route.read_self'], scopeIds: [partition.userId], status: 'active',
  })));
  vi.stubGlobal('fetch', fetchMock);
  const database = new OfflineDatabase(`service-revocation-${crypto.randomUUID()}`, { indexedDB, IDBKeyRange });
  databases.push(database);
  const repository = new OfflineRepository(database);
  await repository.saveValidatedRoute(
    createSyntheticRouteBundle(partition, now), createValidatedLocalSession(partition, now),
  );
  const service = new OfflineFoundationService(database, () => now);
  return { service, repository, values, fetchMock };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.delete()));
  vi.unstubAllGlobals();
});

describe('offline service cross-tab revocation fence', () => {
  it('revokes only the captured seller even if another seller signs in during cleanup', async () => {
    const { service, repository, values } = await setup();
    await repository.saveLocalSession(createValidatedLocalSession(otherPartition, now));
    const revoking = service.revokeLocalAccess();
    values.set('cirne-rotas.last-user-id', otherPartition.userId);
    await revoking;
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(await repository.getLocalSession(otherPartition)).toBeDefined();
    expect(values.get('cirne-rotas.last-user-id')).toBe(otherPartition.userId);
  });

  it('does not reauthenticate or read a partition after an external lock', async () => {
    const { service, fetchMock } = await setup(true);
    service.blockLocalAccess();
    expect(await service.initialize()).toMatchObject({ kind: 'blocked' });
    expect(await service.refresh(partition)).toMatchObject({ kind: 'blocked' });
    await expect(service.startVisit({ userId: partition.userId, routeVersionStopId: crypto.randomUUID() }))
      .rejects.toThrow('revalidada');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discards an identity response arriving after a lock without recreating a session', async () => {
    const { service, repository, values, fetchMock } = await setup(true);
    const entered = deferred(); const release = deferred();
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return original(); });
    const loading = service.initialize();
    await entered.promise;
    service.blockLocalAccess();
    values.delete('cirne-rotas.last-user-id');
    await repository.deleteLocalSession(partition);
    release.resolve();
    expect(await loading).toMatchObject({ kind: 'blocked' });
    expect(await repository.getLocalSession(partition)).toBeUndefined();
    expect(values.has('cirne-rotas.last-user-id')).toBe(false);
  });

  for (const operation of ['initialize', 'refresh'] as const) {
    it(`removes a late ${operation} session write without deleting another seller's session`, async () => {
      const { service, repository, values } = await setup(operation === 'initialize');
      await repository.saveLocalSession(createValidatedLocalSession(otherPartition, now));
      const entered = deferred(); const release = deferred();
      const original = OfflineRepository.prototype.saveLocalSession;
      vi.spyOn(OfflineRepository.prototype, 'saveLocalSession').mockImplementationOnce(async function (this: OfflineRepository, session) {
        entered.resolve(); await release.promise;
        return original.call(this, session);
      });
      const loading = operation === 'initialize' ? service.initialize() : service.refresh(partition);
      await entered.promise;
      service.blockLocalAccess();
      await repository.deleteLocalSession(partition);
      values.set('cirne-rotas.last-user-id', otherPartition.userId);
      release.resolve();
      expect(await loading).toMatchObject({ kind: 'blocked' });
      expect(await repository.getLocalSession(partition)).toBeUndefined();
      expect(await repository.getLocalSession(otherPartition)).toBeDefined();
      expect(values.get('cirne-rotas.last-user-id')).toBe(otherPartition.userId);
      expect(await repository.listRouteBundles(partition)).toHaveLength(1);
    });
  }

  it('discards private records read before revocation but delivered afterwards', async () => {
    const { service, repository } = await setup();
    const entered = deferred(); const release = deferred();
    const original = OfflineRepository.prototype.listRouteBundles;
    vi.spyOn(OfflineRepository.prototype, 'listRouteBundles').mockImplementationOnce(async function (this: OfflineRepository, input) {
      const records = await original.call(this, input);
      entered.resolve(); await release.promise; return records;
    });
    const loading = service.refresh(partition);
    await entered.promise;
    service.blockLocalAccess(); release.resolve();
    expect(await loading).toMatchObject({ kind: 'blocked' });
    expect(await repository.listRouteBundles(partition)).toHaveLength(1);
  });
});
