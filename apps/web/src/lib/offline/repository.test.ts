import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticRouteBundle, createValidatedLocalSession } from '@cirne/domain';
import { OfflineDatabase, offlineV2Stores } from './database';
import { OfflineRepository, type SaveDraftCommand } from './repository';

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

describe('OfflineRepository', () => {
  it('preserves route, session, draft and outbox during the schema v2 to v3 upgrade', async () => {
    const name = `offline-migration-${crypto.randomUUID()}`;
    names.push(name);
    const legacy = new Dexie(name, { indexedDB, IDBKeyRange });
    legacy.version(2).stores(offlineV2Stores);
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
    legacy.close();

    const repository = new OfflineRepository(new OfflineDatabase(name, { indexedDB, IDBKeyRange }));
    await repository.open();
    expect(await repository.listRouteBundles(partitionA)).toEqual([bundle]);
    expect(await repository.listDrafts(partitionA)).toHaveLength(1);
    expect(await repository.listOutbox(partitionA)).toHaveLength(1);
    expect(await repository.getLocalSession(partitionA)).toBeDefined();
    repository.close();
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
    await expect(repository.applySyncConfirmation(partitionA, {
      eventId: saved.event.eventId,
      status: 'confirmed',
      canonicalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      confirmedAt: '2026-09-11T12:05:00.000Z',
    })).rejects.toThrow('Confirmação canônica não corresponde');
    expect(await repository.listOutbox(partitionA)).toHaveLength(1);
    expect(await repository.listDrafts(partitionA)).toMatchObject([{ persistenceState: 'saved_on_device' }]);
  });
});
