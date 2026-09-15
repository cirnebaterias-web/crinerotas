import { describe, expect, it, vi } from 'vitest';
import type { OfflineOutboxEvent, OfflinePartition, SyncBatchResponse } from '@cirne/contracts';
import {
  SyncEngine,
  syncLeaseMs,
  syncRefreshTimeoutMs,
  type SyncQueueRepository,
} from './sync-engine';
import { SyncTransportError, type SyncTransport } from './sync-transport';

const partition: OfflinePartition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};

function event(sequence = 1): OfflineOutboxEvent {
  return {
    schemaVersion: 1,
    ...partition,
    eventId: `60000000-0000-4000-8000-00000000000${sequence}`,
    idempotencyKey: `70000000-0000-4000-8000-00000000000${sequence}`,
    operation: 'visit.draft.saved',
    aggregateId: '50000000-0000-4000-8000-000000000001',
    sequence,
    payload: {
      draftOfflineId: '50000000-0000-4000-8000-000000000001',
      routeVersionStopId: '40000000-0000-4000-8000-000000000001',
      acknowledged: true,
    },
    status: 'sending',
    attemptCount: 1,
    leaseUntil: '2026-09-14T12:00:35.000Z',
    occurredAt: `2026-09-14T12:00:0${sequence}.000Z`,
  };
}

function repository(events: OfflineOutboxEvent[]): SyncQueueRepository {
  return {
    reserveOutboxBatch: vi.fn().mockResolvedValue(events),
    recordOutboxFailure: vi.fn().mockResolvedValue(undefined),
    applySyncConfirmation: vi.fn().mockResolvedValue(true),
  };
}

describe('SyncEngine', () => {
  it('shares the same run lock and persists confirmations individually', async () => {
    const queued = [event(1), event(2)];
    const queue = repository(queued);
    let release!: (response: SyncBatchResponse) => void;
    const pending = new Promise<SyncBatchResponse>((resolve) => { release = resolve; });
    const transport: SyncTransport = { send: vi.fn().mockReturnValue(pending) };
    const engineA = new SyncEngine(queue, transport);
    const engineB = new SyncEngine(queue, transport);

    const first = engineA.synchronize(partition);
    const second = engineB.synchronize(partition);
    expect(first).toBe(second);
    release({
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      results: queued.map((item) => ({
        eventId: item.eventId,
        status: 'confirmed' as const,
        canonicalId: item.aggregateId,
        confirmedAt: '2026-09-14T12:01:00.000Z',
      })),
    });

    await expect(first).resolves.toMatchObject({ attempted: 2, confirmed: 2 });
    expect(queue.reserveOutboxBatch).toHaveBeenCalledWith(
      partition,
      expect.any(String),
      expect.any(String),
      25,
    );
    const reserveCall = vi.mocked(queue.reserveOutboxBatch).mock.calls[0]!;
    expect(Date.parse(reserveCall[2]) - Date.parse(reserveCall[1])).toBe(syncLeaseMs);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(queue.applySyncConfirmation).toHaveBeenCalledTimes(2);
  });

  it('refreshes authentication once and retries with the same event identity', async () => {
    const queued = [event()];
    const queue = repository(queued);
    const response: SyncBatchResponse = {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      results: [{
        eventId: queued[0]!.eventId,
        status: 'confirmed',
        canonicalId: queued[0]!.aggregateId,
        confirmedAt: '2026-09-14T12:01:00.000Z',
      }],
    };
    const transport: SyncTransport = {
      send: vi.fn()
        .mockRejectedValueOnce(new SyncTransportError(401, 'AUTH_REQUIRED'))
        .mockResolvedValueOnce(response),
    };
    const refresh = vi.fn().mockResolvedValue(true);
    const engine = new SyncEngine(queue, transport, refresh);

    await expect(engine.synchronize(partition)).resolves.toMatchObject({ confirmed: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(transport.send).mock.calls[0]).toEqual(vi.mocked(transport.send).mock.calls[1]);
  });

  it('persists network failures with progressive retry and keeps the event', async () => {
    const queue = repository([event()]);
    const transport: SyncTransport = {
      send: vi.fn().mockRejectedValue(new SyncTransportError(503, 'DEPENDENCY_UNAVAILABLE')),
    };
    const engine = new SyncEngine(
      queue,
      transport,
      undefined,
      () => new Date('2026-09-14T12:00:00.000Z'),
      () => 0.5,
    );
    await expect(engine.synchronize(partition)).resolves.toMatchObject({ recoverable: 1 });
    expect(queue.recordOutboxFailure).toHaveBeenCalledWith(partition, event().eventId, {
      status: 'recoverable_error',
      code: 'DEPENDENCY_UNAVAILABLE',
      nextAttemptAt: '2026-09-14T12:00:02.000Z',
    });
  });

  it('does not blindly retry forbidden failures', async () => {
    const queue = repository([event()]);
    const transport: SyncTransport = {
      send: vi.fn().mockRejectedValue(new SyncTransportError(403, 'FORBIDDEN')),
    };
    const engine = new SyncEngine(queue, transport);
    await expect(engine.synchronize(partition)).resolves.toMatchObject({ actionRequired: 1 });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(queue.recordOutboxFailure).toHaveBeenCalledWith(partition, event().eventId, {
      status: 'action_required',
      code: 'FORBIDDEN',
    });
  });

  it('bounds a session refresh that never settles and preserves authentication-required state', async () => {
    vi.useFakeTimers();
    try {
      const queue = repository([event()]);
      const transport: SyncTransport = {
        send: vi.fn().mockRejectedValue(new SyncTransportError(401, 'AUTH_REQUIRED')),
      };
      const engine = new SyncEngine(
        queue,
        transport,
        () => new Promise(() => undefined),
        () => new Date('2026-09-14T12:00:00.000Z'),
        () => 0.5,
      );
      const run = engine.synchronize(partition);
      await vi.advanceTimersByTimeAsync(syncRefreshTimeoutMs);

      await expect(run).resolves.toMatchObject({
        recoverable: 1,
        actionRequired: 0,
        authenticationRequired: true,
      });
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(queue.recordOutboxFailure).toHaveBeenCalledWith(partition, event().eventId, {
        status: 'recoverable_error',
        code: 'AUTH_REQUIRED',
        nextAttemptAt: '2026-09-14T12:00:02.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
