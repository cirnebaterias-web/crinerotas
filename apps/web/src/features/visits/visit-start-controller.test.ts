import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfflineSnapshot } from '../../lib/offline/service';
import { VisitStartController } from './visit-start-controller';

const stamp = '2026-09-17T12:00:00.000Z';
const partition = { userId: 'seller-a', deviceId: 'device-a' };

function fixture() {
  const snapshot: OfflineSnapshot = {
    kind: 'ready', partition, routes: [], workerReady: true, storagePersisted: true,
    drafts: [{
      schemaVersion: 1, ...partition, offlineId: 'visit-a', routeVersionStopId: 'stop-a',
      currentStep: 'start', localStatus: 'draft', persistenceState: 'saved_on_device',
      updatedAt: stamp, deviceStartedAt: stamp,
    }],
    outbox: [{
      schemaVersion: 1, ...partition, operation: 'visit.started.v1', eventId: 'event-a',
      idempotencyKey: 'key-a', aggregateType: 'visit', aggregateId: 'visit-a', sequence: 1, occurredAt: stamp,
      payload: { offlineId: 'visit-a', routeVersionStopId: 'stop-a', deviceStartedAt: stamp },
      status: 'pending', attemptCount: 0,
    }],
  };
  const service = {
    initialize: vi.fn().mockImplementation(async () => snapshot),
    refresh: vi.fn().mockImplementation(async () => snapshot),
    synchronize: vi.fn().mockResolvedValue({ attempted: 1, confirmed: 0, recoverable: 1, actionRequired: 0, authenticationRequired: false }),
    saveVisitStock: vi.fn(),
    saveVisitPrices: vi.fn(),
    listCommercialActions: vi.fn().mockResolvedValue([]),
    listScrapPoints: vi.fn().mockResolvedValue([]),
    saveVisitCommercialActions: vi.fn(),
    saveVisitScrap: vi.fn(),
    getVisitPriceParameters: vi.fn().mockResolvedValue(null),
    listVisitAttachments: vi.fn().mockResolvedValue([]),
    listVisitEvidence: vi.fn().mockResolvedValue([]),
    saveVisitEvidence: vi.fn(),
    saveVisitAttachment: vi.fn(),
    deleteVisitAttachment: vi.fn(),
    close: vi.fn(),
  };
  const publish = vi.fn();
  const online = vi.fn(() => true);
  const controller = new VisitStartController('visit-a', service, publish, online);
  return { snapshot, service, publish, online, controller };
}

afterEach(() => { vi.useRealTimers(); });

describe('VisitStartController', () => {
  it('preserves the previous commercial photo when saving its replacement fails', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    const previous = {
      schemaVersion: 1, ...partition, offlineId: 'previous-photo', visitOfflineId: 'visit-a',
      purpose: 'commercial_action_evidence', targetOfflineId: 'competitor-action',
      capturedAt: stamp, status: 'pending',
    };
    f.service.listVisitAttachments.mockResolvedValue([previous]);
    await f.controller.resume();
    const published = f.publish.mock.calls.length;
    f.service.saveVisitAttachment.mockRejectedValue(new Error('storage full'));
    await expect(f.controller.addCommercialActionEvidence('competitor-action', {
      blob: new Blob(['replacement']), contentType: 'image/jpeg', width: 100, height: 100,
      checksum: 'a'.repeat(64), originalByteSize: 11,
    }, 'replacement.jpg')).rejects.toThrow('storage full');
    expect(f.service.deleteVisitAttachment).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledTimes(published);
    expect(f.publish.mock.lastCall?.[0].attachments).toEqual([previous]);
    f.controller.dispose();
  });

  it('waits for a durable commercial photo replacement before deleting the previous photo', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    const previous = {
      schemaVersion: 1, ...partition, offlineId: 'previous-photo', visitOfflineId: 'visit-a',
      purpose: 'commercial_action_evidence', targetOfflineId: 'competitor-action',
      capturedAt: stamp, status: 'pending',
    };
    const unrelated = { ...previous, offlineId: 'other-photo', targetOfflineId: 'other-action' };
    const replacement = { ...previous, offlineId: 'replacement-photo' };
    f.service.listVisitAttachments.mockResolvedValue([previous, unrelated]);
    await f.controller.resume();
    let finish!: () => void;
    f.service.saveVisitAttachment.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve(replacement);
    }));
    const saving = f.controller.addCommercialActionEvidence('competitor-action', {
      blob: new Blob(['replacement']), contentType: 'image/jpeg', width: 100, height: 100,
      checksum: 'a'.repeat(64), originalByteSize: 11,
    }, 'replacement.jpg');
    expect(f.service.saveVisitAttachment).toHaveBeenCalledOnce();
    expect(f.service.deleteVisitAttachment).not.toHaveBeenCalled();
    expect(f.publish.mock.lastCall?.[0].attachments).toEqual([previous, unrelated]);
    finish();
    await expect(saving).resolves.toEqual(replacement);
    expect(f.service.deleteVisitAttachment).toHaveBeenCalledExactlyOnceWith(partition.userId, 'visit-a', previous.offlineId);
    expect(f.publish.mock.lastCall?.[0].attachments).toEqual([unrelated, replacement]);
    f.controller.dispose();
  });

  it('keeps offline storage open until an attachment operation settles after disposal', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    let finish!: () => void;
    f.service.saveVisitAttachment.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({
        schemaVersion: 1, ...partition, offlineId: 'stock-photo', visitOfflineId: 'visit-a',
        purpose: 'stock_evidence', fileName: 'stock.jpg', contentType: 'image/jpeg', byteSize: 5,
        width: 10, height: 10, checksum: 'a'.repeat(64), capturedAt: stamp, status: 'pending',
        blob: new Blob(['photo'], { type: 'image/jpeg' }),
      });
    }));
    const saving = f.controller.addStockPhoto({
      blob: new Blob(['photo'], { type: 'image/jpeg' }), contentType: 'image/jpeg', width: 10, height: 10,
      checksum: 'a'.repeat(64), originalByteSize: 5,
    }, 'stock.jpg');

    f.controller.dispose();
    expect(f.service.close).not.toHaveBeenCalled();
    finish();
    await saving;
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it('publishes the durable stock commit before requesting synchronization', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    const savedDraft = {
      ...f.snapshot.drafts[0]!, currentStep: 'prices' as const,
      stock: {
        eventId: 'stock-event', heliarQuantity: 0, mouraQuantity: 3,
        deviceSavedAt: stamp, persistenceState: 'saved_on_device' as const,
      },
    };
    f.service.saveVisitStock.mockResolvedValue({ draft: savedDraft, event: {} });
    await expect(f.controller.saveStock({ heliarQuantity: 0, mouraQuantity: 3 })).resolves.toEqual(savedDraft);
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: savedDraft, message: 'Estoque salvo no aparelho.',
    }));
    expect(f.service.synchronize).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('loads the cached catalog and publishes a durable prices commit before synchronization', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    const parameters = {
      schemaVersion: 1 as const,
      ...partition,
      parameterSetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      version: 1,
      validFrom: stamp,
      cachedAt: stamp,
      values: { competitors: [], technologies: [], conditions: [], unavailableReasons: [] },
    };
    f.service.getVisitPriceParameters.mockResolvedValue(parameters);
    await f.controller.resume();
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ priceParameters: parameters }));
    const savedDraft = {
      ...f.snapshot.drafts[0]!, currentStep: 'actions' as const,
      stock: {
        eventId: 'stock-event', heliarQuantity: 0, mouraQuantity: 3,
        deviceSavedAt: stamp, persistenceState: 'saved_on_device' as const,
      },
      prices: {
        eventId: 'prices-event', availability: 'unavailable' as const,
        unavailableReasonId: '88888888-8888-4888-8888-888888888888',
        deviceSavedAt: stamp, persistenceState: 'saved_on_device' as const,
      },
    };
    f.service.saveVisitPrices.mockResolvedValue({ draft: savedDraft, event: {} });
    const values = {
      availability: 'unavailable' as const,
      unavailableReasonId: '88888888-8888-4888-8888-888888888888',
    };
    await expect(f.controller.savePrices(values)).resolves.toEqual(savedDraft);
    expect(f.service.saveVisitPrices).toHaveBeenCalledExactlyOnceWith({
      userId: partition.userId, offlineId: 'visit-a', values,
    });
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: savedDraft, message: 'Preços salvos no aparelho.', priceParameters: parameters,
    }));
    expect(f.service.synchronize).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('coalesces duplicate stock submits and lets an in-flight commit finish after revocation', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    const savedDraft = {
      ...f.snapshot.drafts[0]!, currentStep: 'prices' as const,
      stock: {
        eventId: 'stock-event', heliarQuantity: 0, mouraQuantity: 3,
        deviceSavedAt: stamp, persistenceState: 'saved_on_device' as const,
      },
    };
    let finish!: () => void;
    f.service.saveVisitStock.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ draft: savedDraft, event: {} });
    }));
    const first = f.controller.saveStock({ heliarQuantity: 0, mouraQuantity: 3 });
    expect(f.controller.saveStock({ heliarQuantity: 0, mouraQuantity: 3 })).toBe(first);
    expect(f.service.saveVisitStock).toHaveBeenCalledOnce();
    f.controller.blockAccess();
    expect(f.service.close).not.toHaveBeenCalled();
    const published = f.publish.mock.calls.length;
    finish();
    await first;
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
  });

  it('keeps Dexie open until an in-flight commercial action commit settles after disposal', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    let finish!: () => void;
    f.service.saveVisitCommercialActions.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ draft: f.snapshot.drafts[0], event: {} });
    }));
    const saving = f.controller.saveCommercialActions({
      ownAcknowledgements: [], competitor: { availability: 'not_identified' },
    });
    f.controller.dispose();
    expect(f.service.close).not.toHaveBeenCalled();
    const published = f.publish.mock.calls.length;
    finish();
    await saving;
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
  });

  it('keeps Dexie open until an in-flight scrap commit settles after disposal', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    let finish!: () => void;
    f.service.saveVisitScrap.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ draft: f.snapshot.drafts[0], event: {} });
    }));
    const saving = f.controller.saveScrap({ availability: 'none' });
    f.controller.dispose();
    expect(f.service.close).not.toHaveBeenCalled();
    const published = f.publish.mock.calls.length;
    finish();
    await saving;
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
  });

  it('waits for both action and scrap commits before closing after disposal', async () => {
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    let finishActions!: () => void;
    let finishScrap!: () => void;
    f.service.saveVisitCommercialActions.mockImplementation(() => new Promise((resolve) => {
      finishActions = () => resolve({ draft: f.snapshot.drafts[0], event: {} });
    }));
    f.service.saveVisitScrap.mockImplementation(() => new Promise((resolve) => {
      finishScrap = () => resolve({ draft: f.snapshot.drafts[0], event: {} });
    }));
    const actions = f.controller.saveCommercialActions({
      ownAcknowledgements: [], competitor: { availability: 'not_identified' },
    });
    const scrap = f.controller.saveScrap({ availability: 'none' });
    f.controller.dispose();
    finishActions();
    await actions;
    expect(f.service.close).not.toHaveBeenCalled();
    finishScrap();
    await scrap;
    expect(f.service.close).toHaveBeenCalledOnce();
  });

  it('queues stock synchronization after a run that was already in flight', async () => {
    const f = fixture();
    let finishFirst!: () => void;
    f.service.synchronize
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = () => resolve({
          attempted: 1, confirmed: 1, recoverable: 0, actionRequired: 0,
          authenticationRequired: false,
        });
      }))
      .mockResolvedValue({
        attempted: 1, confirmed: 1, recoverable: 0, actionRequired: 0,
        authenticationRequired: false,
      });
    const firstRun = f.controller.resume();
    await vi.waitFor(() => expect(f.service.synchronize).toHaveBeenCalledOnce());
    const savedDraft = {
      ...f.snapshot.drafts[0]!, currentStep: 'prices' as const,
      stock: {
        eventId: 'stock-event', heliarQuantity: 0, mouraQuantity: 3,
        deviceSavedAt: stamp, persistenceState: 'saved_on_device' as const,
      },
    };
    f.service.saveVisitStock.mockResolvedValue({ draft: savedDraft, event: {} });
    await f.controller.saveStock({ heliarQuantity: 0, mouraQuantity: 3 });
    expect(f.service.synchronize).toHaveBeenCalledOnce();
    finishFirst();
    await firstRun;
    await vi.waitFor(() => expect(f.service.synchronize).toHaveBeenCalledTimes(2));
    f.controller.dispose();
  });

  it('starts offline and sends the existing partition when connectivity returns', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    expect(f.service.synchronize).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('conexão voltar') }));
    f.online.mockReturnValue(true);
    await f.controller.resume();
    expect(f.service.synchronize).toHaveBeenCalledExactlyOnceWith(partition);
    f.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('synchronizes pending evidence after the regular visit outbox is already confirmed', async () => {
    const f = fixture();
    f.snapshot.drafts[0]!.persistenceState = 'synced';
    f.snapshot.drafts[0]!.canonicalVisitId = '77777777-7777-4777-8777-777777777777';
    f.snapshot.outbox = [];
    f.service.listVisitEvidence.mockResolvedValue([{
      schemaVersion: 1,
      ...partition,
      offlineId: 'evidence-a',
      visitOfflineId: 'visit-a',
      kind: 'checkin',
      capturedAt: stamp,
      latitude: '-7.1195',
      longitude: '-34.8450',
      accuracyM: '12',
      distanceM: '18',
      radiusM: 100,
      desiredAccuracyM: 50,
      issues: [],
      status: 'pending',
      expiresAt: '2027-03-16T12:00:00.000Z',
    }]);

    await f.controller.resume();

    expect(f.service.synchronize).toHaveBeenCalledExactlyOnceWith(partition);
    expect(f.publish).toHaveBeenCalledWith(expect.objectContaining({
      busy: true,
      message: expect.stringContaining('Sincronizando em segundo plano'),
    }));
    f.controller.dispose();
  });

  it('does not schedule retries while the visit evidence channel is disabled', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.snapshot.drafts[0]!.persistenceState = 'synced';
    f.snapshot.outbox = [];
    f.service.listVisitEvidence.mockResolvedValue([{
      schemaVersion: 1, ...partition, offlineId: 'evidence-disabled', visitOfflineId: 'visit-a',
      kind: 'checkin', capturedAt: stamp, radiusM: 100, desiredAccuracyM: 50, issues: [],
      status: 'pending', expiresAt: '2027-03-16T12:00:00.000Z',
    }]);
    f.service.synchronize.mockResolvedValue({
      attempted: 0, confirmed: 0, recoverable: 0, actionRequired: 0,
      authenticationRequired: false, evidenceDisabled: true, scrapEvidenceDisabled: false,
    });

    await f.controller.resume();

    expect(f.service.synchronize).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });

  it('backs off before retrying recoverable evidence failures', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.snapshot.drafts[0]!.persistenceState = 'synced';
    f.snapshot.outbox = [];
    f.service.listVisitEvidence.mockResolvedValue([{
      schemaVersion: 1, ...partition, offlineId: 'evidence-retry', visitOfflineId: 'visit-a',
      kind: 'checkin', capturedAt: stamp, radiusM: 100, desiredAccuracyM: 50, issues: [],
      status: 'pending', expiresAt: '2027-03-16T12:00:00.000Z',
    }]);
    f.service.synchronize.mockResolvedValue({
      attempted: 1, confirmed: 0, recoverable: 1, actionRequired: 0,
      authenticationRequired: false, evidenceDisabled: false, scrapEvidenceDisabled: false,
    });

    await f.controller.resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.service.synchronize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.service.synchronize).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });

  it('honors the persisted retry time and never confirms based on another visit in the batch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(stamp);
    const f = fixture();
    f.snapshot.outbox[0]!.status = 'recoverable_error';
    f.snapshot.outbox[0]!.nextAttemptAt = new Date(Date.now() + 5_000).toISOString();
    f.service.synchronize.mockResolvedValue({ attempted: 1, confirmed: 1, recoverable: 0, actionRequired: 0, authenticationRequired: false });
    await f.controller.resume();
    expect(f.publish.mock.lastCall?.[0].message).not.toContain('confirmado');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.service.synchronize).toHaveBeenCalledTimes(1);
    f.service.synchronize.mockImplementation(async () => {
      f.snapshot.drafts[0]!.persistenceState = 'synced';
      f.snapshot.outbox = [];
      return { attempted: 1, confirmed: 1, recoverable: 0, actionRequired: 0, authenticationRequired: false };
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.synchronize).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.lastCall?.[0].message).toContain('confirmado');
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });

  it.each(['FORBIDDEN', 'IDEMPOTENCY_KEY_REUSED', 'VALIDATION_FAILED'] as const)('keeps %s visible without retrying automatically', async (code) => {
    vi.useFakeTimers();
    const f = fixture();
    f.snapshot.outbox[0]!.status = 'action_required';
    f.snapshot.outbox[0]!.lastErrorCode = code;
    await f.controller.resume();
    expect(f.publish.mock.lastCall?.[0].message).toContain('exige revisão');
    expect(f.service.synchronize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });

  it('asks for login after failed refresh instead of scheduling an authentication loop', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.synchronize.mockResolvedValue({ attempted: 1, confirmed: 0, recoverable: 1, actionRequired: 0, authenticationRequired: true });
    await f.controller.resume();
    expect(f.publish.mock.lastCall?.[0]).toMatchObject({ requiresLogin: true, draft: { offlineId: 'visit-a' } });
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });

  it('coalesces foreground/reconnect/manual triggers and closes only after an in-flight commit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.service.synchronize.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.controller.resume();
    expect(f.controller.resume()).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    f.controller.dispose();
    const published = f.publish.mock.calls.length;
    expect(f.service.close).not.toHaveBeenCalled();
    finish();
    await first;
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
  });

  it('hides the previous draft when the identity changes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.online.mockReturnValue(false);
    await f.controller.resume();
    f.snapshot.partition = { ...partition, userId: 'seller-b' };
    await f.controller.resume();
    expect(f.publish.mock.lastCall?.[0]).toMatchObject({ state: 'blocked', draft: null });
    expect(f.service.synchronize).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it('immediately blocks access and cancels retries without discarding saved work', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.resume();
    const saved = structuredClone(f.snapshot);
    expect(vi.getTimerCount()).toBe(1);
    f.controller.blockAccess();
    expect(f.publish.mock.lastCall?.[0]).toMatchObject({ state: 'blocked', draft: null, busy: false });
    expect(vi.getTimerCount()).toBe(0);
    const published = f.publish.mock.calls.length;
    await f.controller.resume();
    f.controller.blockAccess();
    f.controller.dispose();
    expect(f.service.initialize).toHaveBeenCalledOnce();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
    expect(f.snapshot).toEqual(saved);
  });

  it('hides revoked data immediately but lets an in-flight confirmation finish without republishing', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finish!: () => void;
    f.service.synchronize.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const running = f.controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publish.mock.lastCall?.[0].draft).not.toBeNull();
    f.controller.blockAccess();
    expect(f.publish.mock.lastCall?.[0]).toMatchObject({ state: 'blocked', draft: null });
    expect(f.service.close).not.toHaveBeenCalled();
    const published = f.publish.mock.calls.length;
    f.controller.dispose();
    finish();
    await running;
    await f.controller.resume();
    expect(f.service.refresh).not.toHaveBeenCalled();
    expect(f.service.close).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(published);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave a retry scheduled when local refresh is blocked', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.service.refresh.mockResolvedValue({ kind: 'blocked', reason: 'session_expired', message: 'Expired' });
    await f.controller.resume();
    expect(f.publish.mock.lastCall?.[0]).toMatchObject({ state: 'blocked', draft: null });
    expect(vi.getTimerCount()).toBe(0);
    f.controller.dispose();
  });
});
