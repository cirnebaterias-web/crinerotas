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
    close: vi.fn(),
  };
  const publish = vi.fn();
  const online = vi.fn(() => true);
  const controller = new VisitStartController('visit-a', service, publish, online);
  return { snapshot, service, publish, online, controller };
}

afterEach(() => { vi.useRealTimers(); });

describe('VisitStartController', () => {
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
