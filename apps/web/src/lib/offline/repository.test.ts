import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCanonicalLocalRouteBundle,
  createSyntheticRouteBundle,
  createValidatedLocalSession,
  toSyncCommand,
} from '@cirne/domain';
import { OfflineDatabase, offlineV2Stores, offlineV7Stores } from './database';
import { OfflineRepository, type SaveDraftCommand, type SaveVisitStartCommand, type SaveVisitStockCommand } from './repository';
import { SyncEventPersistenceError } from './sync-persistence-error';
import { SyncEngine } from './sync-engine';
import { processSyncBatch, SyncEventFailure } from '../../server/sync/service';

const partitionA = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const partitionB = {
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  deviceId: partitionA.deviceId,
};
const stopId = '44444444-4444-4444-8444-444444444441';
const names: string[] = [];

function makeRepository() {
  const name = `offline-test-${crypto.randomUUID()}`;
  names.push(name);
  const db = new OfflineDatabase(name, { indexedDB, IDBKeyRange });
  return { db, repository: new OfflineRepository(db) };
}

function command(overrides: Partial<SaveDraftCommand> = {}): SaveDraftCommand {
  return {
    partition: partitionA,
    routeVersionStopId: stopId,
    acknowledged: true,
    occurredAt: '2026-09-11T12:01:00.000Z',
    ids: {
      draftOfflineId: '55555555-5555-4555-8555-555555555555',
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    },
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(names.splice(0).map((name) => new Dexie(name, { indexedDB, IDBKeyRange }).delete()));
});

async function seed(repository: OfflineRepository, partition = partitionA) {
  const at = '2026-09-11T12:00:00.000Z';
  await repository.saveValidatedRoute(
    createSyntheticRouteBundle(partition, at),
    createValidatedLocalSession(partition, at),
  );
}

async function seedCanonical(repository: OfflineRepository) {
  const at = '2026-09-17T12:00:00.000Z';
  const bundle = createCanonicalLocalRouteBundle(partitionA, {
    schemaVersion: 3,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 1,
    serviceDate: '2026-09-17',
    status: 'published',
    publishedAt: '2026-09-17T08:00:00.000Z',
    executionVersion: 1,
    seller: { id: partitionA.userId, displayName: 'Vendedor Sintético' },
    compositionChange: null,
    stops: [{
      routeVersionStopId: stopId,
      plannedOrder: 1,
      executionOrder: 1,
      priority: 1,
      status: 'pending',
      executionVersion: 1,
      client: {
        id: '10000000-0000-4000-8000-000000000001',
        externalReference: 'SYN-001',
        name: 'Cliente Sintético',
        address: 'Endereço sintético',
        latitude: null,
        longitude: null,
        portfolioReference: null,
      },
    }],
  }, at);
  await repository.saveValidatedRoute(bundle, createValidatedLocalSession(partitionA, at));
  return bundle;
}

function visitStartCommand(): SaveVisitStartCommand {
  return {
    partition: partitionA,
    routeVersionStopId: stopId,
    deviceStartedAt: '2026-09-17T12:01:00.000Z',
    ids: {
      offlineId: '55555555-5555-4555-8555-555555555555',
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    },
  };
}

describe('OfflineRepository', () => {
  it.each([false, true])('after removal preserves only an existing visit, without creating a new one (started=%s)', async (started) => {
    const { repository } = makeRepository();
    const original = await seedCanonical(repository);
    const saved = started ? await repository.saveVisitStartAndEnqueue(visitStartCommand()) : undefined;
    const revisedAt = '2026-09-17T12:02:00.000Z';
    await repository.saveValidatedRoute({
      ...original, routeVersionId: crypto.randomUUID(), versionNumber: 2, executionVersion: 2,
      cachedAt: revisedAt,
      stops: [{ ...original.stops[0]!, routeVersionStopId: crypto.randomUUID(),
        client: { ...original.stops[0]!.client, id: crypto.randomUUID(), name: 'Novo cliente' } }],
    }, createValidatedLocalSession(partitionA, revisedAt));
    const attempt = repository.saveVisitStartAndEnqueue({
      ...visitStartCommand(),
      ids: { offlineId: crypto.randomUUID(), eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
    });
    if (saved) {
      await expect(attempt).resolves.toMatchObject({ reopened: true, draft: saved.draft, event: saved.event });
      expect(await repository.listDrafts(partitionA)).toEqual([saved.draft]);
      expect(await repository.listOutbox(partitionA)).toEqual([saved.event]);
    } else {
      await expect(attempt).rejects.toThrow('Parada indisponível');
      expect(await repository.listDrafts(partitionA)).toEqual([]);
      expect(await repository.listOutbox(partitionA)).toEqual([]);
    }
    expect(await repository.listDrafts(partitionB)).toEqual([]);
  });

  it.each([2, 7])('preserves route, session, draft and outbox during the schema v%s to v8 upgrade', async (version) => {
    const name = `offline-migration-${crypto.randomUUID()}`;
    names.push(name);
    const legacy = new Dexie(name, { indexedDB, IDBKeyRange });
    legacy.version(version).stores(version === 2 ? offlineV2Stores : offlineV7Stores);
    await legacy.open();
    const bundle = createSyntheticRouteBundle(partitionA, '2026-09-11T12:00:00.000Z');
    await legacy.table('routeBundles').put(bundle);
    await legacy.table('localSessions').put(createValidatedLocalSession(partitionA, '2026-09-11T12:00:00.000Z'));
    await legacy.table('visitDrafts').put({
      schemaVersion: 1,
      ...partitionA,
      offlineId: '55555555-5555-4555-8555-555555555555',
      routeVersionStopId: stopId,
      currentStep: 'start',
      acknowledged: true,
      localStatus: 'draft',
      persistenceState: 'saved_on_device',
      updatedAt: '2026-09-11T12:01:00.000Z',
    });
    await legacy.table('outboxEvents').put({
      schemaVersion: 1,
      ...partitionA,
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
      operation: 'visit.draft.saved',
      aggregateId: '55555555-5555-4555-8555-555555555555',
      sequence: 1,
      payload: { draftOfflineId: '55555555-5555-4555-8555-555555555555', routeVersionStopId: stopId, acknowledged: true },
      status: 'pending',
      attemptCount: 0,
      occurredAt: '2026-09-11T12:01:00.000Z',
    });
    const previousEvent = await legacy.table('outboxEvents').toCollection().first();
    legacy.close();

    const repository = new OfflineRepository(new OfflineDatabase(name, { indexedDB, IDBKeyRange }));
    await repository.open();
    expect(await repository.listRouteBundles(partitionA)).toEqual([bundle]);
    expect(await repository.listDrafts(partitionA)).toHaveLength(1);
    expect(await repository.listOutbox(partitionA)).toEqual([{ ...previousEvent, aggregateType: 'visit_draft' }]);
    expect(await repository.getLocalSession(partitionA)).toBeDefined();
    await seedCanonical(repository);
    const started = await repository.saveVisitStartAndEnqueue({ ...visitStartCommand(), ids: {
      offlineId: crypto.randomUUID(), eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    } });
    expect(started.event).toMatchObject({ aggregateType: 'visit', aggregateId: previousEvent.aggregateId, sequence: 1 });
    expect(await repository.listOutbox(partitionA)).toHaveLength(2);
    repository.close();
  });

  it('atomically replaces a route with its canonical snapshot without clearing durable work', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    await repository.saveDraftAndEnqueue(command());
    const at = '2026-09-11T12:05:00.000Z';
    const canonical = createCanonicalLocalRouteBundle(partitionA, {
      schemaVersion: 2,
      routeId: '33333333-3333-4333-8333-333333333333',
      routeVersionId: '99999999-9999-4999-8999-999999999999',
      versionNumber: 2,
      serviceDate: '2026-09-11',
      status: 'published',
      publishedAt: at,
      executionVersion: 2,
      seller: { id: partitionA.userId, displayName: 'Vendedor A Sintético' },
      stops: [{
        routeVersionStopId: stopId,
        plannedOrder: 1,
        executionOrder: 1,
        priority: 1,
        status: 'pending',
        executionVersion: 2,
        client: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          externalReference: 'SYN-01',
          name: 'Cliente Sintético',
          address: 'Endereço sintético',
          latitude: null,
          longitude: null,
          portfolioReference: null,
        },
      }],
    }, at);
    await repository.saveValidatedRoute(canonical, createValidatedLocalSession(partitionA, at));

    const newerAt = '2026-09-11T12:10:00.000Z';
    const newer = { ...canonical, executionVersion: 3, cachedAt: newerAt };
    await repository.saveValidatedRoute(newer, createValidatedLocalSession(partitionA, newerAt));
    const revalidatedAt = '2026-09-11T12:15:00.000Z';
    await repository.saveValidatedRoute(
      { ...canonical, cachedAt: revalidatedAt },
      createValidatedLocalSession(partitionA, revalidatedAt),
    );
    await repository.saveValidatedRoute(canonical, createValidatedLocalSession(partitionA, at));

    expect(await repository.listRouteBundles(partitionA)).toEqual([newer]);
    expect(await repository.getLocalSession(partitionA)).toMatchObject({ validatedAt: revalidatedAt });
    expect(await repository.listDrafts(partitionA)).toHaveLength(1);
    expect(await repository.listOutbox(partitionA)).toHaveLength(1);
  });

  it('isolates every read by user and device', async () => {
    const { repository } = makeRepository();
    await seed(repository, partitionA);
    await seed(repository, partitionB);
    expect(await repository.listRouteBundles(partitionA)).toHaveLength(1);
    expect((await repository.listRouteBundles(partitionA))[0]?.userId).toBe(partitionA.userId);
    expect((await repository.listRouteBundles(partitionB))[0]?.userId).toBe(partitionB.userId);
    expect(await repository.listRouteBundles({ ...partitionA, deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).toEqual([]);
  });

  it('invalidates only the requested local session while preserving durable work', async () => {
    const { repository } = makeRepository();
    await seed(repository, partitionA);
    await seed(repository, partitionB);

    await repository.deleteLocalSession(partitionA);

    expect(await repository.getLocalSession(partitionA)).toBeUndefined();
    expect(await repository.getLocalSession(partitionB)).toBeDefined();
    expect(await repository.listRouteBundles(partitionA)).toHaveLength(1);
  });

  it('commits draft and outbox atomically, preserving idempotency and sequence', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    const first = await repository.saveDraftAndEnqueue(command());
    const repeated = await repository.saveDraftAndEnqueue(command());
    const next = await repository.saveDraftAndEnqueue(command({
      acknowledged: false,
      occurredAt: '2026-09-11T12:02:00.000Z',
      ids: {
        ...command().ids,
        eventId: '88888888-8888-4888-8888-888888888888',
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
      },
    }));
    expect(first).toMatchObject({ repeated: false, event: { sequence: 1 } });
    expect(repeated).toMatchObject({ repeated: true, event: { sequence: 1, idempotencyKey: first.event.idempotencyKey } });
    expect(next).toMatchObject({ repeated: false, event: { sequence: 2 } });
    expect(await repository.listOutbox(partitionA)).toHaveLength(2);
    expect((await repository.listDrafts(partitionA))[0]?.acknowledged).toBe(false);
  });

  it('rolls back the draft if the outbox write fails with quota exhaustion', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);
    vi.spyOn(db.outboxEvents, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.saveDraftAndEnqueue(command())).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.listDrafts(partitionA)).toEqual([]);
    expect(await repository.listOutbox(partitionA)).toEqual([]);
  });

  it('rejects a draft for a stop outside the requested partition', async () => {
    const { repository } = makeRepository();
    await seed(repository, partitionB);
    await expect(repository.saveDraftAndEnqueue(command())).rejects.toThrow('Parada indisponível nesta partição offline.');
  });

  it('reserves only eligible ordered events and recovers an expired lease', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    const first = await repository.saveDraftAndEnqueue(command());
    const second = await repository.saveDraftAndEnqueue(command({
      occurredAt: '2026-09-11T12:02:00.000Z',
      ids: {
        ...command().ids,
        eventId: '88888888-8888-4888-8888-888888888888',
        idempotencyKey: '99999999-9999-4999-8999-999999999999',
      },
    }));

    const reserved = await repository.reserveOutboxBatch(
      partitionA,
      '2026-09-11T12:03:00.000Z',
      '2026-09-11T12:03:30.000Z',
    );
    expect(reserved.map(({ eventId, status, attemptCount }) => ({ eventId, status, attemptCount }))).toEqual([
      { eventId: first.event.eventId, status: 'sending', attemptCount: 1 },
      { eventId: second.event.eventId, status: 'sending', attemptCount: 1 },
    ]);
    expect(await repository.reserveOutboxBatch(
      partitionA,
      '2026-09-11T12:03:10.000Z',
      '2026-09-11T12:03:40.000Z',
    )).toEqual([]);
    expect(await repository.reserveOutboxBatch(
      partitionA,
      '2026-09-11T12:03:31.000Z',
      '2026-09-11T12:04:00.000Z',
    )).toHaveLength(2);
  });

  it('persists recoverable/actionable failures without losing the event or idempotency key', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    const saved = await repository.saveDraftAndEnqueue(command());
    await repository.reserveOutboxBatch(partitionA, '2026-09-11T12:02:00.000Z', '2026-09-11T12:02:30.000Z');

    const failed = await repository.recordOutboxFailure(partitionA, saved.event.eventId, {
      status: 'recoverable_error',
      code: 'DEPENDENCY_UNAVAILABLE',
      nextAttemptAt: '2026-09-11T12:03:00.000Z',
    });
    expect(failed).toMatchObject({
      status: 'recoverable_error',
      attemptCount: 1,
      idempotencyKey: saved.event.idempotencyKey,
      lastErrorCode: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(await repository.reserveOutboxBatch(
      partitionA,
      '2026-09-11T12:02:59.000Z',
      '2026-09-11T12:03:30.000Z',
    )).toEqual([]);
  });

  it('removes an event and marks its draft synced in the same confirmation transaction', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    const saved = await repository.saveDraftAndEnqueue(command());
    const applied = await repository.applySyncConfirmation(partitionA, {
      eventId: saved.event.eventId,
      status: 'confirmed',
      canonicalId: saved.event.aggregateId,
      confirmedAt: '2026-09-11T12:05:00.000Z',
    });

    expect(applied).toBe(true);
    expect(await repository.listOutbox(partitionA)).toEqual([]);
    expect(await repository.listDrafts(partitionA)).toMatchObject([{
      offlineId: saved.event.aggregateId,
      persistenceState: 'synced',
      updatedAt: '2026-09-11T12:05:00.000Z',
    }]);
  });

  it('keeps local work when a confirmation identifies another aggregate', async () => {
    const { repository } = makeRepository();
    await seed(repository);
    const saved = await repository.saveDraftAndEnqueue(command());
    const confirmation = repository.applySyncConfirmation(partitionA, {
      eventId: saved.event.eventId,
      status: 'confirmed',
      canonicalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      confirmedAt: '2026-09-11T12:05:00.000Z',
    });
    await expect(confirmation).rejects.toMatchObject({
      name: SyncEventPersistenceError.name,
      message: expect.stringContaining('Confirmação canônica não corresponde'),
    });
    expect(await repository.listOutbox(partitionA)).toHaveLength(1);
    expect(await repository.listDrafts(partitionA)).toMatchObject([{ persistenceState: 'saved_on_device' }]);
  });

  it('keeps the canonical start when another event remains and preserves it after the final confirmation', async () => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const saved = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    const laterEvent = {
      ...saved.event!, eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
      operation: 'visit.draft.saved' as const, aggregateType: 'visit_draft' as const, sequence: 2,
      payload: { draftOfflineId: saved.draft.offlineId, routeVersionStopId: stopId, acknowledged: true },
    };
    await db.outboxEvents.add(laterEvent);
    const confirmation = {
      eventId: saved.event!.eventId, status: 'confirmed' as const,
      canonicalId: '88888888-8888-4888-8888-888888888888', confirmedAt: '2026-09-17T12:01:01.000Z',
    };
    await repository.applySyncConfirmation(partitionA, confirmation);
    const expectedStart = {
      canonicalVisitId: confirmation.canonicalId, serverStartedAt: confirmation.confirmedAt,
      deviceStartedAt: saved.draft.deviceStartedAt,
    };
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toMatchObject({
      ...expectedStart, persistenceState: 'saved_on_device',
    });
    expect(await repository.listOutbox(partitionA)).toEqual([laterEvent]);
    expect(await repository.applySyncConfirmation(partitionA, confirmation)).toBe(false);
    await repository.applySyncConfirmation(partitionA, {
      eventId: laterEvent.eventId, status: 'confirmed', canonicalId: saved.draft.offlineId,
      confirmedAt: '2026-09-17T12:02:00.000Z',
    });
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toMatchObject({
      ...expectedStart, persistenceState: 'synced', updatedAt: '2026-09-17T12:02:00.000Z',
    });
    expect(await repository.listOutbox(partitionA)).toEqual([]);
  });

  it('rolls back the confirmed event deletion if the canonical draft cannot be saved', async () => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const saved = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    vi.spyOn(db.visitDrafts, 'put').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.applySyncConfirmation(partitionA, {
      eventId: saved.event!.eventId, status: 'confirmed',
      canonicalId: '88888888-8888-4888-8888-888888888888', confirmedAt: '2026-09-17T12:01:01.000Z',
    })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toEqual(saved.draft);
    expect(await repository.listOutbox(partitionA)).toEqual([saved.event]);
  });

  it('commits visit start and outbox atomically, reopens it and associates the canonical visit', async () => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const saved = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    expect(saved).toMatchObject({
      reopened: false,
      draft: { deviceStartedAt: '2026-09-17T12:01:00.000Z', persistenceState: 'saved_on_device' },
      event: { operation: 'visit.started.v1', sequence: 1 },
    });
    const reopened = await repository.saveVisitStartAndEnqueue({
      ...visitStartCommand(),
      ids: {
        offlineId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(reopened.reopened).toBe(true);
    expect(reopened.draft.offlineId).toBe(saved.draft.offlineId);
    expect(await repository.listOutbox(partitionA)).toHaveLength(1);

    await repository.applySyncConfirmation(partitionA, {
      eventId: saved.event!.eventId,
      status: 'confirmed',
      canonicalId: '88888888-8888-4888-8888-888888888888',
      confirmedAt: '2026-09-17T12:01:01.000Z',
    });
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toMatchObject({
      canonicalVisitId: '88888888-8888-4888-8888-888888888888',
      serverStartedAt: '2026-09-17T12:01:01.000Z',
      persistenceState: 'synced',
    });
    expect(await repository.listOutbox(partitionA)).toEqual([]);

    await db.visitDrafts.clear();
    vi.spyOn(db.outboxEvents, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.saveVisitStartAndEnqueue({
      ...visitStartCommand(),
      ids: {
        offlineId: crypto.randomUUID(),
        eventId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      },
    })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.listDrafts(partitionA)).toEqual([]);
  });

  it.each([false, true])('starts an existing legacy draft without duplicating its identity (confirmed=%s)', async (confirmed) => {
    const { repository } = makeRepository();
    await seedCanonical(repository);
    const legacy = await repository.saveDraftAndEnqueue(command());
    if (confirmed) {
      await repository.applySyncConfirmation(partitionA, {
        eventId: legacy.event.eventId, status: 'confirmed', canonicalId: legacy.draft.offlineId,
        confirmedAt: '2026-09-17T12:00:00.000Z',
      });
    }
    const start = { ...visitStartCommand(), ids: {
      offlineId: crypto.randomUUID(), eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    } };
    const saved = await repository.saveVisitStartAndEnqueue(start);
    expect(saved).toMatchObject({
      reopened: false,
      draft: { offlineId: legacy.draft.offlineId, acknowledged: true, deviceStartedAt: start.deviceStartedAt },
      event: { operation: 'visit.started.v1', aggregateId: legacy.draft.offlineId, sequence: 1,
        payload: { offlineId: legacy.draft.offlineId } },
    });
    expect(await repository.listDrafts(partitionA)).toEqual([saved.draft]);
    expect(await repository.findDraftForStop(partitionA, stopId)).toEqual(saved.draft);
    expect(await repository.listOutbox(partitionA)).toEqual(confirmed ? [saved.event] : [legacy.event, saved.event]);
    expect(saved.draft.lastConfirmedSequence).toBeUndefined();
    expect(toSyncCommand(saved.event!)).toMatchObject({ aggregateType: 'visit', sequence: 1 });
    const reopened = await repository.saveVisitStartAndEnqueue(start);
    expect(reopened).toMatchObject({ reopened: true, draft: saved.draft });
    expect(await repository.listDrafts(partitionA)).toHaveLength(1);
    expect(await repository.listDrafts(partitionB)).toEqual([]);
  });

  it.each([false, true])('syncs independent draft/visit sequences through the engine and batch service (legacy confirmed first=%s)', async (confirmedFirst) => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const legacyEvents = [];
    for (let index = 0; index < 5; index += 1) {
      const legacy = await repository.saveDraftAndEnqueue(command({ ids: {
        draftOfflineId: command().ids.draftOfflineId,
        eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
      } }));
      legacyEvents.push(legacy.event);
    }
    const canonicalId = crypto.randomUUID();
    const confirmedSequences = new Map<string, number>();
    const engine = new SyncEngine(repository, { send: async (batch) => processSyncBatch(
      batch, crypto.randomUUID(), { synchronize: async (_deviceId, event) => {
        const key = `${event.aggregateType}:${event.aggregateId}`;
        expect(event.sequence).toBe((confirmedSequences.get(key) ?? 0) + 1);
        confirmedSequences.set(key, event.sequence);
        return { eventId: event.eventId, status: 'confirmed',
          canonicalId: event.aggregateType === 'visit' ? canonicalId : event.aggregateId,
          confirmedAt: '2026-09-17T12:05:00.000Z' };
      } },
    ) });
    if (confirmedFirst) expect(await engine.synchronize(partitionA)).toMatchObject({ confirmed: 5 });
    const started = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    expect(started.event).toMatchObject({ sequence: 1, aggregateType: 'visit' });
    expect(started.draft.lastConfirmedSequence).toBeUndefined();
    const stockCommand: SaveVisitStockCommand = { partition: partitionA, offlineId: started.draft.offlineId,
      heliarQuantity: 0, mouraQuantity: 7, deviceSavedAt: '2026-09-17T12:02:00.000Z',
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } };
    const stock = await repository.saveVisitStockAndEnqueue(stockCommand);
    expect(stock.event.sequence).toBe(2);
    // Sequence 1 is legal in each namespace, but still unique within the visit.
    await expect(db.outboxEvents.add({ ...started.event!, eventId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ name: 'ConstraintError' });
    if (!confirmedFirst) {
      const queued = await repository.listOutbox(partitionA);
      expect(queued.filter(event => event.aggregateType === 'visit_draft')
        .sort((left, right) => left.sequence - right.sequence)).toEqual(legacyEvents);
    }
    expect(await engine.synchronize(partitionA)).toMatchObject({
      confirmed: confirmedFirst ? 2 : 7, recoverable: 0, actionRequired: 0,
    });
    expect(await repository.listOutbox(partitionA)).toEqual([]);
    expect(await repository.getDraft(partitionA, started.draft.offlineId)).toMatchObject({
      canonicalVisitId: canonicalId, lastConfirmedSequence: 2, persistenceState: 'synced',
      stock: { heliarQuantity: 0, mouraQuantity: 7, persistenceState: 'synced' },
    });
    const edited = await repository.saveVisitStockAndEnqueue({ ...stockCommand,
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } });
    expect(edited.event.sequence).toBe(3);
  });

  it('keeps legacy reservation, server and local-confirmation failures isolated from the visit namespace', async () => {
    const { repository } = makeRepository();
    await seedCanonical(repository);
    const legacy = await repository.saveDraftAndEnqueue(command());
    const started = await repository.saveVisitStartAndEnqueue({ ...visitStartCommand(), ids: {
      offlineId: crypto.randomUUID(), eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    } });
    await repository.recordOutboxFailure(partitionA, legacy.event.eventId, {
      status: 'action_required', code: 'VALIDATION_FAILED',
    });
    const reserved = await repository.reserveOutboxBatch(partitionA, '2026-09-17T12:02:00.000Z', '2026-09-17T12:03:00.000Z');
    expect(reserved.map(event => event.eventId)).toEqual([started.event!.eventId]);
    const batch = { deviceId: partitionA.deviceId, events: [legacy.event, started.event!].map(toSyncCommand) };
    const response = await processSyncBatch(batch, crypto.randomUUID(), { synchronize: async (_deviceId, event) => {
      if (event.aggregateType === 'visit_draft') throw new SyncEventFailure('VALIDATION_FAILED', 'invalid legacy', false);
      return { eventId: event.eventId, status: 'confirmed', canonicalId: crypto.randomUUID(),
        confirmedAt: '2026-09-17T12:02:00.000Z' };
    } });
    expect(response.results.map(result => result.status)).toEqual(['rejected', 'confirmed']);
    const apply = vi.fn().mockRejectedValueOnce(new SyncEventPersistenceError('legacy mismatch')).mockResolvedValueOnce(true);
    const engine = new SyncEngine({ reserveOutboxBatch: async () => [legacy.event, started.event!],
      recordOutboxFailure: vi.fn(), applySyncConfirmation: apply }, {
      send: async () => ({ requestId: crypto.randomUUID(), results: [legacy.event, started.event!].map(event => ({
        eventId: event.eventId, status: 'confirmed' as const, canonicalId: event.aggregateId,
        confirmedAt: '2026-09-17T12:02:00.000Z',
      })) }),
    });
    expect(await engine.synchronize(partitionA)).toMatchObject({ confirmed: 1, actionRequired: 1, recoverable: 0 });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('preserves the legacy draft and its pending event when starting fails to enqueue', async () => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const legacy = await repository.saveDraftAndEnqueue(command());
    vi.spyOn(db.outboxEvents, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.saveVisitStartAndEnqueue({ ...visitStartCommand(), ids: {
      offlineId: crypto.randomUUID(), eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    } })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.listDrafts(partitionA)).toEqual([legacy.draft]);
    expect(await repository.listOutbox(partitionA)).toEqual([legacy.event]);
  });

  it.each(['stock-edit', 'legacy-event'])('persists each stock confirmation while %s remains pending', async (laterKind) => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const started = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    const canonicalId = '88888888-8888-4888-8888-888888888888';
    await repository.applySyncConfirmation(partitionA, {
      eventId: started.event!.eventId, status: 'confirmed', canonicalId,
      confirmedAt: '2026-09-17T12:01:01.000Z',
    });
    const stock = { partition: partitionA, offlineId: started.draft.offlineId,
      heliarQuantity: 0, mouraQuantity: 7, deviceSavedAt: '2026-09-17T12:02:00.000Z',
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } };
    const saved = await repository.saveVisitStockAndEnqueue(stock);
    if (laterKind === 'stock-edit') {
      await repository.saveVisitStockAndEnqueue({ ...stock, mouraQuantity: 9,
        deviceSavedAt: '2026-09-17T12:03:00.000Z',
        ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } });
    } else {
      // A valid later legacy event shares the aggregate but does not supersede its stock section.
      await db.outboxEvents.add({ ...saved.event, operation: 'visit.draft.saved', aggregateType: 'visit_draft', sequence: 3,
        eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
        payload: { draftOfflineId: saved.draft.offlineId, routeVersionStopId: stopId, acknowledged: true } });
    }
    const beforeDraft = await repository.getDraft(partitionA, saved.draft.offlineId);
    const beforeOutbox = await repository.listOutbox(partitionA);
    const confirmation = { eventId: saved.event.eventId, status: 'confirmed' as const, canonicalId,
      confirmedAt: '2026-09-17T12:03:01.000Z' };
    vi.spyOn(db.visitDrafts, 'put').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.applySyncConfirmation(partitionA, confirmation))
      .rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toEqual(beforeDraft);
    expect(await repository.listOutbox(partitionA)).toEqual(beforeOutbox);
    await repository.applySyncConfirmation(partitionA, confirmation);
    expect(await repository.getDraft(partitionA, saved.draft.offlineId)).toMatchObject({
      canonicalVisitId: canonicalId, lastConfirmedSequence: 2,
      persistenceState: 'saved_on_device', updatedAt: beforeDraft!.updatedAt,
      stock: laterKind === 'stock-edit'
        ? { mouraQuantity: 9, persistenceState: 'saved_on_device' }
        : { mouraQuantity: 7, persistenceState: 'synced', serverSavedAt: confirmation.confirmedAt },
    });
    expect(await repository.listOutbox(partitionA)).toEqual(beforeOutbox.filter(e => e.eventId !== saved.event.eventId));
  });

  it('commits stock with the next aggregate sequence, restores zero and confirms only its event', async () => {
    const { db, repository } = makeRepository();
    await seedCanonical(repository);
    const started = await repository.saveVisitStartAndEnqueue(visitStartCommand());
    await repository.applySyncConfirmation(partitionA, {
      eventId: started.event!.eventId,
      status: 'confirmed',
      canonicalId: '88888888-8888-4888-8888-888888888888',
      confirmedAt: '2026-09-17T12:01:01.000Z',
    });
    const stockCommand: SaveVisitStockCommand = {
      partition: partitionA,
      offlineId: started.draft.offlineId,
      heliarQuantity: 0,
      mouraQuantity: 7,
      observation: '  conferido  ',
      deviceSavedAt: '2026-09-17T12:02:00.000Z',
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
    };
    const saved = await repository.saveVisitStockAndEnqueue(stockCommand);
    expect(saved.event).toMatchObject({ operation: 'visit.stock.saved.v1', sequence: 2 });
    expect(saved.draft).toMatchObject({
      currentStep: 'prices',
      stock: { heliarQuantity: 0, mouraQuantity: 7, observation: 'conferido', persistenceState: 'saved_on_device' },
    });
    vi.spyOn(db.outboxEvents, 'add').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(repository.saveVisitStockAndEnqueue({
      ...stockCommand,
      mouraQuantity: 8,
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
    })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await repository.getDraft(partitionA, started.draft.offlineId)).toEqual(saved.draft);

    await repository.applySyncConfirmation(partitionA, {
      eventId: saved.event.eventId,
      status: 'confirmed',
      canonicalId: '88888888-8888-4888-8888-888888888888',
      confirmedAt: '2026-09-17T12:02:01.000Z',
    });
    expect(await repository.getDraft(partitionA, started.draft.offlineId)).toMatchObject({
      lastConfirmedSequence: 2,
      persistenceState: 'synced',
      stock: { heliarQuantity: 0, persistenceState: 'synced', serverSavedAt: '2026-09-17T12:02:01.000Z' },
    });

    const edited = await repository.saveVisitStockAndEnqueue({
      ...stockCommand,
      mouraQuantity: 9,
      deviceSavedAt: '2026-09-17T12:03:00.000Z',
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
    });
    expect(edited.event).toMatchObject({
      operation: 'visit.stock.saved.v1',
      sequence: 3,
      payload: { heliarQuantity: 0, mouraQuantity: 9 },
    });
    expect(edited.event.eventId).not.toBe(saved.event.eventId);
    expect(edited.event.idempotencyKey).not.toBe(saved.event.idempotencyKey);
    expect(await repository.listOutbox(partitionA)).toEqual([edited.event]);
  });
});
