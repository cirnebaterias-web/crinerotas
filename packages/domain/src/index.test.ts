import { describe, expect, it } from 'vitest';
import {
  createDraftMutation,
  createSyntheticRouteBundle,
  createValidatedLocalSession,
  evaluateLocalAccess,
  localAccessWindowMs,
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
