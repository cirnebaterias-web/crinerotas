import { expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  liveResponseSchema,
  localPersistenceStateSchema,
  localRouteBundleSchema,
  localSessionSchema,
  localVisitDraftSchema,
  meResponseSchema,
  offlineOutboxEventSchema,
  offlineOutboxStatusSchema,
} from './index';

it('rejects extra fields and incompatible health responses', () => {
  for (const value of [{ status: 'down' }, { status: 'ok', secret: 'private' }, null, {}]) {
    expect(liveResponseSchema.safeParse(value).success).toBe(false);
  }
  expect(liveResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
});

it('validates the authenticated identity response without extra data', () => {
  const value = {
    id: 'dcd459e5-5cdc-4745-b239-0a231a9f5cd7',
    displayName: 'Vendedor A Sintético',
    roles: ['seller'],
    capabilities: ['identity.read_self'],
    scopeIds: ['dcd459e5-5cdc-4745-b239-0a231a9f5cd7'],
    status: 'active',
  };
  expect(meResponseSchema.parse(value)).toEqual(value);
  expect(meResponseSchema.safeParse({ ...value, token: 'secret' }).success).toBe(false);
  expect(meResponseSchema.safeParse({ ...value, roles: ['owner'] }).success).toBe(false);
  expect(meResponseSchema.safeParse({ ...value, capabilities: ['invalid'] }).success).toBe(false);
});

it('validates the unified error envelope', () => {
  const value = {
    error: {
      code: 'authentication_required',
      message: 'Autenticação necessária.',
      recoverable: true,
      timestamp: '2026-09-11T12:00:00.000Z',
      requestId: 'bff3dbdf-05ab-4adc-8a23-9707bad2ad6a',
    },
  };
  expect(apiErrorResponseSchema.parse(value)).toEqual(value);
  expect(apiErrorResponseSchema.safeParse({ error: { ...value.error, token: 'secret' } }).success).toBe(false);
});

const partition = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};

it('validates versioned offline records and rejects private or unknown fields', () => {
  const bundle = {
    schemaVersion: 1,
    ...partition,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersion: 1,
    parameterSetVersion: 1,
    serviceDate: '2026-09-11',
    stops: [{
      routeVersionStopId: '44444444-4444-4444-8444-444444444444',
      displayLabel: 'Parada sintética 01',
      executionOrder: 1,
      priority: 0,
    }],
    cachedAt: '2026-09-11T12:00:00.000Z',
  };
  expect(localRouteBundleSchema.parse(bundle)).toEqual(bundle);
  expect(localRouteBundleSchema.safeParse({ ...bundle, token: 'secret' }).success).toBe(false);

  const session = {
    schemaVersion: 1,
    ...partition,
    validatedAt: '2026-09-11T12:00:00.000Z',
    validUntil: '2026-09-12T12:00:00.000Z',
    lastObservedAt: '2026-09-11T12:00:00.000Z',
  };
  expect(localSessionSchema.parse(session)).toEqual(session);

  const draft = {
    schemaVersion: 1,
    ...partition,
    offlineId: '55555555-5555-4555-8555-555555555555',
    routeVersionStopId: bundle.stops[0]!.routeVersionStopId,
    currentStep: 'start',
    acknowledged: true,
    localStatus: 'draft',
    persistenceState: 'saved_on_device',
    updatedAt: '2026-09-11T12:01:00.000Z',
  };
  expect(localVisitDraftSchema.parse(draft)).toEqual(draft);

  const event = {
    schemaVersion: 1,
    ...partition,
    eventId: '66666666-6666-4666-8666-666666666666',
    idempotencyKey: '77777777-7777-4777-8777-777777777777',
    operation: 'visit.draft.saved',
    aggregateId: draft.offlineId,
    sequence: 1,
    payload: {
      draftOfflineId: draft.offlineId,
      routeVersionStopId: draft.routeVersionStopId,
      acknowledged: true,
    },
    status: 'pending',
    attemptCount: 0,
    occurredAt: '2026-09-11T12:01:00.000Z',
  };
  expect(offlineOutboxEventSchema.parse(event)).toEqual(event);
  expect(offlineOutboxEventSchema.safeParse({ ...event, status: 'synced' }).success).toBe(false);
});

it('exposes all visible states while keeping synced out of the local outbox', () => {
  expect(localPersistenceStateSchema.options).toEqual([
    'saved_on_device',
    'pending',
    'recoverable_error',
    'action_required',
    'synced',
  ]);
  expect(offlineOutboxStatusSchema.options).not.toContain('synced');
});
