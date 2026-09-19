import { describe, expect, it } from 'vitest';
import {
  assertExpectedRouteVersion,
  createCanonicalLocalRouteBundle,
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
  normalizeRouteComposition,
  diffRouteComposition,
  orderOutboxEvents,
  normalizeRouteDraft,
  normalizePendingStopOrder,
  restoreCanonicalRoute,
  toRouteTodayResponse,
  toSyncCommand,
  assertVisitCanStart,
  createVisitStartMutation,
  normalizeVisitStart,
  normalizeStockInput,
  createVisitStockMutation,
} from './index';

it('normalizes stock and creates the next visit event while preserving zero', () => {
  expect(normalizeStockInput({ heliarQuantity: 0, mouraQuantity: 2, observation: '  conferido   no local  ' }))
    .toEqual({ heliarQuantity: 0, mouraQuantity: 2, observation: 'conferido no local' });
  const mutation = createVisitStockMutation({
    draft: {
      schemaVersion: 1,
      userId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222',
      offlineId: '55555555-5555-4555-8555-555555555555',
      routeVersionStopId: '44444444-4444-4444-8444-444444444444',
      currentStep: 'start',
      deviceStartedAt: '2026-09-17T12:00:00.000Z',
      localStatus: 'draft',
      persistenceState: 'synced',
      lastConfirmedSequence: 1,
      updatedAt: '2026-09-17T12:00:01.000Z',
    },
    values: { heliarQuantity: 0, mouraQuantity: 2 },
    deviceSavedAt: '2026-09-17T12:05:00.000Z',
    sequence: 2,
    ids: {
      eventId: '66666666-6666-4666-8666-666666666667',
      idempotencyKey: '77777777-7777-4777-8777-777777777778',
    },
  });
  expect(mutation.draft).toMatchObject({
    currentStep: 'prices',
    stock: { heliarQuantity: 0, mouraQuantity: 2, persistenceState: 'saved_on_device' },
  });
  expect(toSyncCommand(mutation.event)).toMatchObject({
    operation: 'visit.stock.saved.v1', aggregateType: 'visit', sequence: 2,
  });
});

it('normalizes a valid route draft while preserving non-contiguous business order', () => {
  const normalized = normalizeRouteDraft({
    schemaVersion: 1,
    serviceDate: '2026-09-15',
    sellerId: '11111111-1111-4111-8111-111111111111',
    stops: [
      { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', plannedOrder: 3, priority: 0 },
      { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', plannedOrder: 1, priority: 1 },
    ],
  });
  expect(normalized.stops.map(({ plannedOrder }) => plannedOrder)).toEqual([1, 3]);
  expect(() => normalizeRouteDraft({
    ...normalized,
    stops: [normalized.stops[0]!, { ...normalized.stops[1]!, plannedOrder: 1 }],
  })).toThrow('Rota em rascunho inválida.');
});

it('checks optimistic route versions and creates a stable empty route response', () => {
  expect(() => assertExpectedRouteVersion(2, 1)).toThrow('A versão enviada conflita com o servidor.');
  expect(() => assertExpectedRouteVersion(0, 0)).toThrow('Versão de rota inválida.');
  expect(assertExpectedRouteVersion(2, 2)).toBeUndefined();
  expect(toRouteTodayResponse(null, '2026-09-15')).toEqual({
    schemaVersion: 2,
    availability: 'empty',
    serviceDate: '2026-09-15',
  });
});

it('validates aggregate execution order without sorting away the seller intent', () => {
  const command = {
    schemaVersion: 1 as const,
    expectedVersion: 2,
    pendingStopIds: [
      '40000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000001',
    ],
  };
  expect(normalizePendingStopOrder(command)).toEqual(command);
  expect(() => normalizePendingStopOrder({
    ...command,
    pendingStopIds: [command.pendingStopIds[0]!, command.pendingStopIds[0]!],
  })).toThrow('Ordem de execução inválida.');
});

it('normalizes a composition reason/order and computes a stable client diff', () => {
  const normalized = normalizeRouteComposition({
    schemaVersion: 1,
    expectedVersion: 2,
    reason: '  Ajuste   solicitado  ',
    stops: [
      { clientId: '10000000-0000-4000-8000-000000000003', plannedOrder: 2, priority: 1 },
      { clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 1, priority: 0 },
    ],
  });
  expect(normalized.reason).toBe('Ajuste solicitado');
  expect(normalized.stops.map(({ plannedOrder }) => plannedOrder)).toEqual([1, 2]);
  expect(diffRouteComposition(
    ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'],
    ['10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'],
  )).toEqual({
    addedClientIds: ['10000000-0000-4000-8000-000000000003'],
    removedClientIds: ['10000000-0000-4000-8000-000000000001'],
    retainedClientIds: ['10000000-0000-4000-8000-000000000002'],
  });
});

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

it('creates an exact canonical local snapshot without synthetic parameters', () => {
  const route = {
    schemaVersion: 2 as const,
    routeId: '33333333-3333-4333-8333-333333333333',
    routeVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 2,
    serviceDate: '2026-09-16',
    status: 'published' as const,
    publishedAt: '2026-09-16T10:00:00.000Z',
    executionVersion: 3,
    seller: { id: partition.userId, displayName: 'Vendedor A Sintético' },
    stops: [{
      routeVersionStopId: '55555555-5555-4555-8555-555555555555',
      plannedOrder: 1,
      executionOrder: 1,
      priority: 2,
      status: 'pending' as const,
      executionVersion: 3,
      client: {
        id: '66666666-6666-4666-8666-666666666666',
        externalReference: 'SYN-01',
        name: 'Cliente Sintético',
        address: 'Endereço sintético',
        latitude: null,
        longitude: null,
        portfolioReference: null,
      },
    }],
  };
  const snapshot = createCanonicalLocalRouteBundle(
    partition,
    route,
    '2026-09-16T10:05:00.000Z',
  );
  expect(snapshot).toMatchObject({ ...partition, ...route });
  expect(snapshot).not.toHaveProperty('parameterSetVersion');
  expect(restoreCanonicalRoute(snapshot)).toEqual(route);
  expect(toRouteTodayResponse(route, route.serviceDate, 3)).toMatchObject({
    schemaVersion: 2,
    availability: 'available',
    route: { schemaVersion: 2 },
  });
  expect(() => createCanonicalLocalRouteBundle(
    { ...partition, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    route,
    snapshot.cachedAt,
  )).toThrow('A rota não pertence à partição offline informada.');
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

it('creates a visit start draft and the matching versioned outbox event', () => {
  const startedAt = '2026-09-17T12:00:00.000Z';
  const mutation = createVisitStartMutation({
    partition,
    routeVersionStopId: '44444444-4444-4444-8444-444444444441',
    deviceStartedAt: startedAt,
    sequence: 1,
    ids: {
      offlineId: '55555555-5555-4555-8555-555555555555',
      eventId: '66666666-6666-4666-8666-666666666666',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    },
  });
  expect(mutation.draft).toMatchObject({
    offlineId: mutation.event.aggregateId,
    deviceStartedAt: startedAt,
    persistenceState: 'saved_on_device',
  });
  expect(toSyncCommand(mutation.event)).toMatchObject({
    operation: 'visit.started.v1',
    aggregateType: 'visit',
    occurredAt: startedAt,
    payload: { offlineId: mutation.draft.offlineId, deviceStartedAt: startedAt },
  });
  expect(normalizeVisitStart({ schemaVersion: 1, ...mutation.event.payload }))
    .toMatchObject({ offlineId: mutation.draft.offlineId });
  expect(assertVisitCanStart('pending')).toBeUndefined();
  expect(() => assertVisitCanStart('in_visit')).toThrow('não está disponível');
});
