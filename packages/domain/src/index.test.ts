import { describe, expect, it } from 'vitest';
import {
  createDraftMutation,
  createSyntheticRouteBundle,
  createValidatedLocalSession,
  canonicalizeSyncCommand,
  classifySyncFailure,
  createSyncBatches,
  evaluateLocalAccess,
  hashSyncCommand,
  localAccessWindowMs,
  nextRetryDelayMs,
  orderOutboxEvents,
  toSyncCommand,
} from './index';

const partition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};

describe('local access policy', () => {
  const validatedAt = '2026-09-11T12:00:00.000Z';

  it('allows the same partition inside exactly 24 hours and advances observation time', () => {
    const session = createValidatedLocalSession(partition, validatedAt);
    expect(Date.parse(session.validUntil) - Date.parse(validatedAt)).toBe(localAccessWindowMs);
    expect(evaluateLocalAccess(session, partition, '2026-09-12T11:59:59.999Z')).toEqual({
      allowed: true,
      session: { ...session, lastObservedAt: '2026-09-12T11:59:59.999Z' },
    });
  });

  it('fails closed for expiry, another identity, and clock rollback', () => {
    const session = createValidatedLocalSession(partition, validatedAt);
    expect(evaluateLocalAccess(session, partition, '2026-09-12T12:00:00.001Z')).toEqual({
      allowed: false,
      reason: 'session_expired',
    });
    expect(evaluateLocalAccess(session, { ...partition, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, validatedAt)).toEqual({
      allowed: false,
      reason: 'identity_mismatch',
    });
    expect(evaluateLocalAccess({ ...session, lastObservedAt: '2026-09-11T13:00:00.000Z' }, partition, '2026-09-11T12:59:59.999Z')).toEqual({
      allowed: false,
      reason: 'clock_rollback',
    });
  });
});

it('creates a coherent draft/outbox mutation without a synced state', () => {
  const mutation = createDraftMutation({
    partition,
    routeVersionStopId: '44444444-4444-4444-8444-444444444441',
    acknowledged: true,
    sequence: 2,
    occurredAt: '2026-09-11T12:01:00.000Z',
    ids: {
      draftOfflineId: '55555555-5555-4555-8555-555555555555',
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    },
  });
  expect(mutation.draft.persistenceState).toBe('saved_on_device');
  expect(mutation.event).toMatchObject({
    aggregateId: mutation.draft.offlineId,
    sequence: 2,
    status: 'pending',
    attemptCount: 0,
  });
  expect(mutation.event.status).not.toBe('synced');
});

it('rejects invalid identifiers, timestamps, and sequences before persistence', () => {
  expect(() => createValidatedLocalSession(
    { ...partition, userId: 'not-a-uuid' },
    '2026-09-11T12:00:00.000Z',
  )).toThrow();
  expect(() => createSyntheticRouteBundle(partition, 'not-a-timestamp')).toThrow();
  expect(() => createDraftMutation({
    partition,
    routeVersionStopId: '44444444-4444-4444-8444-444444444441',
    acknowledged: true,
    sequence: 0,
    occurredAt: '2026-09-11T12:01:00.000Z',
    ids: {
      draftOfflineId: '55555555-5555-4555-8555-555555555555',
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    },
  })).toThrow();
});

it('creates only deterministic synthetic route content', () => {
  const first = createSyntheticRouteBundle(partition, '2026-09-11T12:00:00.000Z');
  const second = createSyntheticRouteBundle(partition, '2026-09-11T12:00:00.000Z');
  expect(second).toEqual(first);
  expect(JSON.stringify(first)).toContain('sintética');
  expect(JSON.stringify(first)).not.toMatch(/@|rua|avenida|telefone/i);
});

function createEvent(aggregateId: string, sequence: number) {
  return createDraftMutation({
    partition,
    routeVersionStopId: '44444444-4444-4444-8444-444444444441',
    acknowledged: true,
    sequence,
    occurredAt: `2026-09-11T12:0${sequence}:00.000Z`,
    ids: {
      draftOfflineId: aggregateId,
      eventId: `66666666-6666-4666-8666-${String(sequence).padStart(12, '0')}`,
      idempotencyKey: `77777777-7777-4777-8777-${String(sequence).padStart(12, '0')}`,
    },
  }).event;
}

it('creates stable canonical sync commands and hashes regardless of object key order', async () => {
  const command = toSyncCommand(createEvent('55555555-5555-4555-8555-555555555555', 1));
  const reordered = {
    ...command,
    payload: {
      acknowledged: command.payload.acknowledged,
      routeVersionStopId: command.payload.routeVersionStopId,
      draftOfflineId: command.payload.draftOfflineId,
    },
  };
  expect(canonicalizeSyncCommand(reordered)).toBe(canonicalizeSyncCommand(command));
  expect(await hashSyncCommand(reordered)).toBe(await hashSyncCommand(command));
  expect(await hashSyncCommand(command)).toMatch(/^[a-f0-9]{64}$/);
});

it('orders events per aggregate and partitions batches at 25 items', () => {
  const firstAggregate = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondAggregate = '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const unordered = [
    createEvent(secondAggregate, 2),
    createEvent(firstAggregate, 2),
    createEvent(secondAggregate, 1),
    createEvent(firstAggregate, 1),
  ];
  expect(orderOutboxEvents(unordered).map(({ aggregateId, sequence }) => [aggregateId, sequence]))
    .toEqual([[firstAggregate, 1], [firstAggregate, 2], [secondAggregate, 1], [secondAggregate, 2]]);
  const many = Array.from({ length: 26 }, (_, index) => createEvent(
    `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
    1,
  ));
  expect(createSyncBatches(many).map((batch) => batch.length)).toEqual([25, 1]);
});

it('classifies retryable, authentication, dependency and action-required failures', () => {
  expect(classifySyncFailure(503, 'DEPENDENCY_UNAVAILABLE')).toBe('recoverable');
  expect(classifySyncFailure(401, 'AUTH_REQUIRED')).toBe('authentication_required');
  expect(classifySyncFailure(409, 'EVENT_OUT_OF_ORDER')).toBe('dependency');
  expect(classifySyncFailure(409, 'IDEMPOTENCY_KEY_REUSED')).toBe('action_required');
  expect(nextRetryDelayMs(1, () => 0.5)).toBe(2_000);
  expect(nextRetryDelayMs(99, () => 0.5)).toBe(300_000);
  expect(() => nextRetryDelayMs(0)).toThrow('Contagem de tentativa inválida.');
});
