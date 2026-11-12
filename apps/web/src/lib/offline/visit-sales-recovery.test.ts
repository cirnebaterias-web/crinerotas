import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localVisitDraftSchema, type LocalVisitEvidence } from '@cirne/contracts';
import { createSyntheticRouteBundle, createValidatedLocalSession, createVisitSalesMutation } from '@cirne/domain';
import { OfflineDatabase } from './database';
import { OfflineRepository } from './repository';
import { OfflineFoundationService } from './service';

const partition = { userId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222' };
const visitId = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-12T12:00:00.000Z';
const completedAt = '2026-11-10T12:00:00.000Z';
const values = { heliarQuantity: 0, americaQuantity: 2, stradaDurexQuantity: 3 };
const databases: OfflineDatabase[] = [];
const legacy = () => localVisitDraftSchema.parse({ schemaVersion: 1, ...partition, offlineId: visitId,
  routeVersionStopId: '44444444-4444-4444-8444-444444444444', currentStep: 'complete',
  localStatus: 'completed', canonicalVisitId: visitId, deviceStartedAt: completedAt, deviceCompletedAt: completedAt,
  persistenceState: 'synced', lastConfirmedSequence: 5, updatedAt: completedAt,
  commercialActions: { ownAcknowledgements: [], competitor: { availability: 'not_identified' },
    eventId: crypto.randomUUID(), deviceSavedAt: completedAt, persistenceState: 'synced' },
  scrap: { availability: 'none', eventId: crypto.randomUUID(), deviceSavedAt: completedAt, persistenceState: 'synced' },
});
function checkout(): LocalVisitEvidence {
  return { schemaVersion: 1, ...partition, offlineId: crypto.randomUUID(), visitOfflineId: visitId,
    kind: 'checkout', capturedAt: completedAt, latitude: '-7.1', longitude: '-34.8',
    radiusM: 30, desiredAccuracyM: 50, issues: ['camera_unavailable'], justification: 'Câmera sintética indisponível',
    status: 'pending', expiresAt: '2026-11-11T12:00:00.000Z' };
}
async function fixture() {
  const db = new OfflineDatabase(`sales-recovery-${crypto.randomUUID()}`, { indexedDB, IDBKeyRange });
  databases.push(db);
  const repository = new OfflineRepository(db);
  await repository.saveValidatedRoute(createSyntheticRouteBundle(partition, at), createValidatedLocalSession(partition, at));
  await db.visitDrafts.put(legacy());
  const evidence = checkout();
  await db.visitEvidence.put(evidence);
  const blob = new Blob(['original legacy evidence'], { type: 'image/jpeg' });
  const photo = { schemaVersion: 1 as const, ...partition, offlineId: crypto.randomUUID(), visitOfflineId: visitId,
    purpose: 'visit_checkin' as const, fileName: 'original.jpg', contentType: 'image/jpeg' as const, byteSize: blob.size,
    width: 10, height: 10, checksum: 'a'.repeat(64), capturedAt: completedAt, status: 'verified' as const, blob };
  await db.attachments.put(photo);
  const storage = new Map([['cirne-rotas.device-id', partition.deviceId], ['cirne-rotas.last-user-id', partition.userId]]);
  vi.stubGlobal('window', { location: { hostname: 'example.invalid' }, localStorage: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  vi.stubGlobal('navigator', { onLine: false });
  const service = new OfflineFoundationService(db, () => at);
  return { db, repository, service, evidence, photo };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(databases.splice(0).map(async (db) => { db.close(); await db.delete(); }));
});

describe('legacy local checkout sales recovery', () => {
  it('upgrades and restarts offline without reopening other steps or losing the original checkout and bytes', async () => {
    const f = await fixture();
    const snapshot = await f.service.initialize();
    expect(snapshot.kind === 'ready' && snapshot.drafts[0]).toMatchObject({
      localStatus: 'completed', currentStep: 'sales', salesCompletionRecovery: true, deviceCompletedAt: completedAt,
    });
    expect(await f.repository.listVisitEvidence(partition, visitId)).toEqual([f.evidence]);
    expect(await (await f.repository.getVisitAttachment(partition, f.photo.offlineId))?.blob.text()).toBe('original legacy evidence');
    f.service.close();
    const resumed = new OfflineFoundationService(f.db, () => at);
    const restarted = await resumed.initialize();
    expect(restarted.kind === 'ready' && restarted.drafts[0]?.salesCompletionRecovery).toBe(true);
    const saved = await resumed.saveVisitSales({ userId: partition.userId, offlineId: visitId, values, expectedVersion: 0 });
    expect(saved.draft).toMatchObject({ localStatus: 'completed', currentStep: 'complete', deviceCompletedAt: completedAt,
      sales: { ...values, version: 1 } });
    expect(saved.event.sequence).toBe(6);
    expect(await f.repository.listVisitEvidence(partition, visitId)).toEqual([f.evidence]);
    resumed.close();
  });

  it.each(['already_completed', 'requires_sales', 'unavailable'] as const)(
    'replays the original checkout before sales and resolves %s safely', async (mode) => {
      const f = await fixture();
      await f.service.initialize();
      const saved = await f.service.saveVisitSales({ userId: partition.userId, offlineId: visitId, values, expectedVersion: 0 });
      if (mode === 'already_completed') await f.repository.recordOutboxFailure(partition, saved.event.eventId,
        { status: 'action_required', code: 'VERSION_CONFLICT' });
      const order: string[] = [];
      const checkoutBodies: string[] = [];
      let salesAccepted = false;
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        const path = String(url);
        if (path.endsWith('/complete')) {
          order.push('checkout'); checkoutBodies.push(String(init?.body));
          expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(f.evidence.offlineId);
          if (mode === 'unavailable' || (mode === 'requires_sales' && !salesAccepted)) return Response.json({ error: {
            code: mode === 'unavailable' ? 'DEPENDENCY_UNAVAILABLE' : 'EVENT_OUT_OF_ORDER',
            message: 'Checkout aguardando confirmação.', recoverable: mode === 'unavailable', timestamp: at, requestId: crypto.randomUUID(),
          } }, { status: mode === 'unavailable' ? 503 : 409 });
          return Response.json({ schemaVersion: 1, visitId, offlineId: visitId, status: 'completed', deviceCompletedAt: completedAt, serverCompletedAt: at });
        }
        if (path.endsWith('/sync/batches')) {
          order.push('sales'); salesAccepted = true;
          const batch = JSON.parse(String(init?.body));
          expect(batch.events).toHaveLength(1);
          expect(batch.events[0].operation).toBe('visit.sales.saved.v1');
          return Response.json({ requestId: crypto.randomUUID(), results: [{ eventId: saved.event.eventId,
            status: 'confirmed', canonicalId: visitId, confirmedAt: at }] });
        }
        throw new Error(`Unexpected request: ${path}`);
      }));
      vi.stubGlobal('navigator', { onLine: true });
      const result = await f.service.synchronize(partition);
      const draft = (await f.repository.getDraft(partition, visitId))!;
      if (mode === 'unavailable') {
        expect(order).toEqual(['checkout']);
        expect(draft.serverCompletedAt).toBeUndefined();
        expect(await f.repository.listOutbox(partition)).toHaveLength(1);
        expect(result.actionRequired).toBe(0);
      } else {
        expect(order).toEqual(mode === 'already_completed' ? ['checkout'] : ['checkout', 'sales', 'checkout']);
        expect(draft).toMatchObject({ localStatus: 'completed', serverCompletedAt: at });
        expect(draft.salesCompletionRecovery).toBeUndefined();
        expect(await f.repository.listOutbox(partition)).toEqual([]);
        expect((await f.repository.listVisitEvidence(partition, visitId))[0]).toMatchObject({ ...f.evidence, status: 'synced', serverSyncedAt: at });
        if (mode === 'already_completed') {
          expect(draft.sales).toBeUndefined();
          expect(draft.salesRecoveryResolution).toMatchObject({ outcome: 'server_already_completed', cancelledSalesEvents: [{
            eventId: saved.event.eventId, idempotencyKey: saved.event.idempotencyKey, sequence: 6, payload: saved.event.payload,
          }] });
        } else {
          expect(checkoutBodies[0]).toBe(checkoutBodies[1]);
          expect(draft.sales).toMatchObject({ ...values, persistenceState: 'synced' });
          expect(draft.salesRecoveryResolution).toBeUndefined();
        }
        await expect(f.service.saveVisitSales({ userId: partition.userId, offlineId: visitId, values, expectedVersion: 1 })).rejects.toThrow('encerrada');
      }
      expect(await (await f.repository.getVisitAttachment(partition, f.photo.offlineId))?.blob.text()).toBe('original legacy evidence');
    },
  );

  it('keeps an acknowledged legacy completion read-only even when the draft had only a generic sync flag', async () => {
    const f = await fixture();
    await f.db.visitEvidence.put({ ...f.evidence, status: 'synced', serverSyncedAt: at });
    await f.repository.prepareVisitSalesRecovery(partition);
    const draft = (await f.repository.getDraft(partition, visitId))!;
    expect(draft.serverCompletedAt).toBe(at);
    expect(draft.salesCompletionRecovery).toBeUndefined();
    expect(() => createVisitSalesMutation({ draft, values, deviceSavedAt: at, sequence: 6,
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } })).toThrow();
    expect(() => createVisitSalesMutation({ draft: { ...draft, salesCompletionRecovery: true }, values,
      deviceSavedAt: at, sequence: 6, ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() } })).toThrow();
  });

  it('holds only the unresolved recovery visit while another visit synchronizes', async () => {
    const f = await fixture();
    await f.service.initialize();
    const held = await f.service.saveVisitSales({ userId: partition.userId, offlineId: visitId, values, expectedVersion: 0 });
    const otherId = crypto.randomUUID();
    const other = createVisitSalesMutation({
      draft: { ...legacy(), offlineId: otherId, canonicalVisitId: otherId, localStatus: 'draft' },
      values, deviceSavedAt: at, sequence: 6,
      ids: { eventId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
    });
    await f.db.visitDrafts.put(other.draft);
    await f.db.outboxEvents.put(other.event);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/complete')) return Response.json({ error: {
        code: 'DEPENDENCY_UNAVAILABLE', message: 'Unavailable', recoverable: true,
        timestamp: at, requestId: crypto.randomUUID(),
      } }, { status: 503 });
      const batch = JSON.parse(String(init?.body));
      expect(batch.events.map((event: { eventId: string }) => event.eventId)).toEqual([other.event.eventId]);
      return Response.json({ requestId: crypto.randomUUID(), results: [{ eventId: other.event.eventId,
        status: 'confirmed', canonicalId: otherId, confirmedAt: at }] });
    }));
    vi.stubGlobal('navigator', { onLine: true });
    await f.service.synchronize(partition);
    expect((await f.repository.listOutbox(partition)).map((event) => event.eventId)).toEqual([held.event.eventId]);
    expect((await f.repository.getDraft(partition, otherId))?.sales?.persistenceState).toBe('synced');
    expect((await f.repository.getDraft(partition, visitId))?.serverCompletedAt).toBeUndefined();
  });

  it('rolls back cancellation and the checkout ACK together if the durable resolution cannot be committed', async () => {
    const f = await fixture();
    await f.service.initialize();
    await f.service.saveVisitSales({ userId: partition.userId, offlineId: visitId, values, expectedVersion: 0 });
    vi.spyOn(f.db.visitDrafts, 'put').mockRejectedValueOnce(new Error('storage full'));
    await expect(f.repository.markVisitEvidenceSynced(partition, f.evidence.offlineId, at)).rejects.toThrow('storage full');
    expect(await f.repository.listOutbox(partition)).toHaveLength(1);
    expect((await f.repository.listVisitEvidence(partition, visitId))[0]?.status).toBe('pending');
    expect((await f.repository.getDraft(partition, visitId))?.serverCompletedAt).toBeUndefined();
  });
});
