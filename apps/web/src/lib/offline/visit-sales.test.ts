import Dexie from 'dexie';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localVisitDraftSchema, offlineOutboxEventSchema, visitSalesInputSchema } from '@cirne/contracts';
import { createVisitSalesMutation, toSyncCommand } from '@cirne/domain';
import { OfflineDatabase } from './database';
import { OfflineRepository } from './repository';

const at = '2026-11-12T12:00:00.000Z';
const partition = { userId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' };
const offlineId = '33333333-3333-4333-8333-333333333333';
const values = { heliarQuantity: 0, americaQuantity: 0, stradaDurexQuantity: 0 };
const draft = () => localVisitDraftSchema.parse({ schemaVersion: 1, ...partition, offlineId,
  routeVersionStopId: '44444444-4444-4444-8444-444444444444', currentStep: 'review',
  deviceStartedAt: at, localStatus: 'draft', persistenceState: 'synced', updatedAt: at,
  canonicalVisitId: offlineId, lastConfirmedSequence: 5,
  commercialActions: { ownAcknowledgements: [], competitor: { availability: 'not_identified' },
    eventId: crypto.randomUUID(), deviceSavedAt: at, persistenceState: 'synced' },
  scrap: { availability: 'none', eventId: crypto.randomUUID(), deviceSavedAt: at, persistenceState: 'synced' },
});
const ids = () => ({ eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() });
const databases: OfflineDatabase[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(databases.splice(0).map(async (db) => {
  db.close(); await new Dexie(db.name, { indexedDB, IDBKeyRange }).delete();
})); });
async function fixture() {
  const db = new OfflineDatabase(`sales-${crypto.randomUUID()}`, { indexedDB, IDBKeyRange });
  databases.push(db);
  await db.visitDrafts.put(draft());
  return { db, repository: new OfflineRepository(db) };
}

describe('visit sales contract and domain', () => {
  it('accepts explicit zeros and rejects absent, negative, decimal and nonnumeric quantities', () => {
    expect(visitSalesInputSchema.parse(values)).toEqual(values);
    for (const invalid of [undefined, '', '1', 'invalid', -1, 1.5, NaN]) {
      expect(visitSalesInputSchema.safeParse({ ...values, heliarQuantity: invalid }).success).toBe(false);
    }
    expect(localVisitDraftSchema.parse(draft()).sales).toBeUndefined();
  });
  it('preserves legacy scrap and starts a new version without renumbering prior events', () => {
    const original = draft();
    const first = createVisitSalesMutation({ draft: original, values, sequence: 6, deviceSavedAt: at, ids: ids() });
    const second = createVisitSalesMutation({ draft: first.draft, values: { ...values, americaQuantity: 4 },
      sequence: 7, deviceSavedAt: at, ids: ids() });
    expect(first.draft.scrap).toEqual(original.scrap);
    expect(first.draft.currentStep).toBe('review');
    expect(second.draft.sales?.version).toBe(2);
    expect(toSyncCommand(second.event)).toMatchObject({ sequence: 7, payload: { expectedVersion: 1 } });
    expect(() => createVisitSalesMutation({ draft: { ...original, localStatus: 'completed' }, values,
      sequence: 6, deviceSavedAt: at, ids: ids() })).toThrow();
    expect(offlineOutboxEventSchema.parse({ schemaVersion: 1, ...partition, ...ids(), aggregateId: offlineId,
      operation: 'visit.scrap.saved.v1', sequence: 5, payload: { schemaVersion: 1, offlineId, deviceSavedAt: at,
        availability: 'none' }, status: 'pending', attemptCount: 0, occurredAt: at }).sequence).toBe(5);
  });
});

describe('durable visit sales', () => {
  it('recovers edits offline in the same database and ignores an old ACK for the latest section', async () => {
    const { db, repository } = await fixture();
    const first = await repository.saveVisitSalesAndEnqueue({ partition, offlineId, values, deviceSavedAt: at, ids: ids() });
    const edited = await repository.saveVisitSalesAndEnqueue({ partition, offlineId, values: { ...values, heliarQuantity: 8 }, deviceSavedAt: at, ids: ids() });
    expect([first.event.sequence, edited.event.sequence]).toEqual([6, 7]);
    await repository.applySyncConfirmation(partition, { eventId: first.event.eventId, status: 'confirmed', canonicalId: offlineId, confirmedAt: at });
    db.close(); await db.open();
    const recovered = (await repository.listDrafts(partition))[0]!;
    expect(recovered.sales).toMatchObject({ heliarQuantity: 8, version: 2, persistenceState: 'saved_on_device' });
    await repository.applySyncConfirmation(partition, { eventId: edited.event.eventId, status: 'confirmed', canonicalId: offlineId, confirmedAt: at });
    expect((await repository.listDrafts(partition))[0]!.sales?.persistenceState).toBe('synced');
    expect(await repository.listDrafts({ ...partition, userId: crypto.randomUUID() })).toEqual([]);
  });
  it('rolls back both section and event when durable enqueue fails', async () => {
    const { db, repository } = await fixture();
    vi.spyOn(db.outboxEvents, 'add').mockRejectedValueOnce(new Error('storage full'));
    await expect(repository.saveVisitSalesAndEnqueue({ partition, offlineId, values, deviceSavedAt: at, ids: ids() })).rejects.toThrow('storage full');
    expect((await repository.listDrafts(partition))[0]!.sales).toBeUndefined();
    expect(await repository.listOutbox(partition)).toEqual([]);
  });
  it('rejects a stale local editor without overwriting a newer declaration', async () => {
    const { repository } = await fixture();
    await repository.saveVisitSalesAndEnqueue({ partition, offlineId, values, expectedVersion: 0, deviceSavedAt: at, ids: ids() });
    await expect(repository.saveVisitSalesAndEnqueue({ partition, offlineId, values: { ...values, americaQuantity: 9 },
      expectedVersion: 0, deviceSavedAt: at, ids: ids() })).rejects.toThrow('alterado em outra tela');
    expect((await repository.listDrafts(partition))[0]!.sales?.americaQuantity).toBe(0);
    expect(await repository.listOutbox(partition)).toHaveLength(1);
  });
  it('blocks checkout of an old running visit without a declaration', async () => {
    const { repository } = await fixture();
    await expect(repository.saveVisitEvidence(partition, { schemaVersion: 1, ...partition,
      offlineId: crypto.randomUUID(), visitOfflineId: offlineId, kind: 'checkout', capturedAt: at,
      radiusM: 30, desiredAccuracyM: 50, issues: ['camera_unavailable'], justification: 'Câmera sintética indisponível',
      status: 'pending', expiresAt: '2027-01-01T00:00:00.000Z' })).rejects.toThrow('informe de venda');
  });
});
