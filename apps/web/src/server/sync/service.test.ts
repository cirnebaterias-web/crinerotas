import { describe, expect, it, vi } from 'vitest';
import type { SyncBatchRequest } from '@cirne/contracts';
import { processSyncBatch, SyncEventFailure, type SyncEventRepository } from './service';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function command(aggregateId: string, sequence: number, suffix: string) {
  return {
    eventId: `10000000-0000-4000-8000-0000000000${suffix}`,
    idempotencyKey: `20000000-0000-4000-8000-0000000000${suffix}`,
    operation: 'visit.draft.saved' as const,
    schemaVersion: 1 as const,
    sequence,
    aggregateType: 'visit_draft' as const,
    aggregateId,
    occurredAt: `2026-09-14T12:00:0${sequence}.000Z`,
    payload: {
      draftOfflineId: aggregateId,
      routeVersionStopId: '30000000-0000-4000-8000-000000000001',
      acknowledged: true,
    },
  };
}

describe('sync batch service', () => {
  it('preserves input order and confirms independent events', async () => {
    const repository: SyncEventRepository = {
      synchronize: vi.fn(async (_deviceId, event) => ({
        eventId: event.eventId,
        status: 'confirmed' as const,
        canonicalId: event.aggregateId,
        confirmedAt: '2026-09-14T12:01:00.000Z',
      })),
    };
    const first = command('40000000-0000-4000-8000-000000000001', 1, '01');
    const second = command('40000000-0000-4000-8000-000000000002', 1, '02');
    const result = await processSyncBatch({ deviceId, events: [first, second] }, requestId, repository);

    expect(result.results.map(({ eventId }) => eventId)).toEqual([first.eventId, second.eventId]);
    expect(result.results.every(({ status }) => status === 'confirmed')).toBe(true);
  });

  it('blocks later events from a failed aggregate while continuing independent aggregates', async () => {
    const failedAggregate = '40000000-0000-4000-8000-000000000001';
    const events = [
      command(failedAggregate, 1, '01'),
      command(failedAggregate, 2, '02'),
      command('40000000-0000-4000-8000-000000000002', 1, '03'),
    ];
    const repository: SyncEventRepository = {
      synchronize: vi.fn(async (_deviceId, event) => {
        if (event.aggregateId === failedAggregate) {
          throw new SyncEventFailure('VALIDATION_FAILED', 'sensitive database detail', false);
        }
        return {
          eventId: event.eventId,
          status: 'confirmed' as const,
          canonicalId: event.aggregateId,
          confirmedAt: '2026-09-14T12:01:00.000Z',
        };
      }),
    };
    const result = await processSyncBatch({ deviceId, events } as SyncBatchRequest, requestId, repository);

    expect(result.results.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'confirmed']);
    expect(result.results[0]).toMatchObject({ error: { code: 'VALIDATION_FAILED', recoverable: false } });
    expect(result.results[1]).toMatchObject({ error: { code: 'EVENT_OUT_OF_ORDER', recoverable: false } });
    expect(JSON.stringify(result)).not.toContain('sensitive database detail');
    expect(repository.synchronize).toHaveBeenCalledTimes(2);
  });

  it('turns unexpected repository failures into recoverable public errors', async () => {
    const event = command('40000000-0000-4000-8000-000000000001', 1, '01');
    const repository: SyncEventRepository = {
      synchronize: vi.fn().mockRejectedValue(new Error('network secret')),
    };
    const result = await processSyncBatch({ deviceId, events: [event] }, requestId, repository);

    expect(result.results[0]).toMatchObject({
      status: 'recoverable_error',
      error: { code: 'INTERNAL_ERROR', recoverable: true },
    });
    expect(JSON.stringify(result)).not.toContain('network secret');
  });
});
