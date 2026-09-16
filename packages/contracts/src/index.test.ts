import { expect, it } from 'vitest';
import {
  apiErrorResponseSchema,
  canonicalRouteSchema,
  createRouteDraftRequestSchema,
  liveResponseSchema,
  localPersistenceStateSchema,
  localRouteBundleSchema,
  localSessionSchema,
  localVisitDraftSchema,
  meResponseSchema,
  offlineOutboxEventSchema,
  offlineOutboxStatusSchema,
  publishRouteRequestSchema,
  routeDraftSchema,
  routePublicationSchema,
  routeTodayResponseSchema,
  syncBatchRequestSchema,
  syncBatchExchangeSchema,
  syncBatchResponseSchema,
  syncCommandSchema,
} from './index';

const routeRequest = {
  schemaVersion: 1 as const,
  serviceDate: '2026-09-15',
  sellerId: '11111111-1111-4111-8111-111111111111',
  stops: [
    { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', plannedOrder: 1, priority: 1 },
    { clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', plannedOrder: 3, priority: 0 },
  ],
};

it('validates a route draft command without inventing contiguous order', () => {
  expect(createRouteDraftRequestSchema.parse(routeRequest)).toEqual(routeRequest);
  expect(createRouteDraftRequestSchema.safeParse({
    ...routeRequest,
    stops: [routeRequest.stops[0]!, { ...routeRequest.stops[1]!, clientId: routeRequest.stops[0]!.clientId }],
  }).success).toBe(false);
  expect(createRouteDraftRequestSchema.safeParse({
    ...routeRequest,
    stops: [routeRequest.stops[0]!, { ...routeRequest.stops[1]!, plannedOrder: 1 }],
  }).success).toBe(false);
  expect(createRouteDraftRequestSchema.safeParse({ ...routeRequest, internalStatus: 'published' }).success).toBe(false);
});

it('keeps draft, publication and canonical route responses strict', () => {
  const draft = {
    ...routeRequest,
    routeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    routeVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    versionNumber: 1,
    expectedVersion: 1,
    status: 'draft' as const,
    stops: routeRequest.stops.map((stop, index) => ({
      ...stop,
      routeVersionStopId: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`,
    })),
  };
  expect(routeDraftSchema.parse(draft)).toEqual(draft);
  expect(publishRouteRequestSchema.parse({ schemaVersion: 1, expectedVersion: 1 }))
    .toEqual({ schemaVersion: 1, expectedVersion: 1 });
  const publication = {
    schemaVersion: 1 as const,
    routeId: draft.routeId,
    routeVersionId: draft.routeVersionId,
    versionNumber: 1,
    expectedVersion: 2,
    status: 'published' as const,
    publishedBy: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    publishedAt: '2026-09-15T12:00:00.000Z',
    stopCount: 2,
  };
  expect(routePublicationSchema.parse(publication)).toEqual(publication);

  const route = {
    schemaVersion: 1 as const,
    routeId: draft.routeId,
    routeVersionId: draft.routeVersionId,
    versionNumber: 1,
    serviceDate: routeRequest.serviceDate,
    status: 'published' as const,
    publishedAt: publication.publishedAt,
    seller: { id: routeRequest.sellerId, displayName: 'Vendedor A Sintético' },
    stops: draft.stops.map((stop, index) => ({
      routeVersionStopId: stop.routeVersionStopId,
      plannedOrder: stop.plannedOrder,
      executionOrder: stop.plannedOrder,
      priority: stop.priority,
      status: 'pending' as const,
      executionVersion: 1,
      client: {
        id: stop.clientId,
        externalReference: `SYN-${index + 1}`,
        name: `Cliente Sintético ${index + 1}`,
        address: `Endereço sintético ${index + 1}`,
        latitude: null,
        longitude: null,
        portfolioReference: null,
      },
    })),
  };
  expect(canonicalRouteSchema.parse(route)).toEqual(route);
  expect(routeTodayResponseSchema.parse({ schemaVersion: 1, availability: 'available', route }))
    .toEqual({ schemaVersion: 1, availability: 'available', route });
  expect(routeTodayResponseSchema.parse({
    schemaVersion: 1,
    availability: 'empty',
    serviceDate: routeRequest.serviceDate,
  })).toEqual({ schemaVersion: 1, availability: 'empty', serviceDate: routeRequest.serviceDate });
  expect(canonicalRouteSchema.safeParse({ ...route, token: 'private' }).success).toBe(false);
});

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
  expect(offlineOutboxStatusSchema.options).toContain('sending');
});

const syncCommand = {
  eventId: '66666666-6666-4666-8666-666666666666',
  idempotencyKey: '77777777-7777-4777-8777-777777777777',
  operation: 'visit.draft.saved' as const,
  schemaVersion: 1 as const,
  sequence: 1,
  aggregateType: 'visit_draft' as const,
  aggregateId: '55555555-5555-4555-8555-555555555555',
  occurredAt: '2026-09-11T12:01:00.000Z',
  payload: {
    draftOfflineId: '55555555-5555-4555-8555-555555555555',
    routeVersionStopId: '44444444-4444-4444-8444-444444444444',
    acknowledged: true,
  },
};

it('validates strict sync commands and limits batches to 25 events', () => {
  expect(syncCommandSchema.parse(syncCommand)).toEqual(syncCommand);
  expect(syncCommandSchema.safeParse({
    ...syncCommand,
    aggregateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }).success).toBe(false);
  expect(syncBatchRequestSchema.parse({ deviceId: partition.deviceId, events: [syncCommand] }))
    .toEqual({ deviceId: partition.deviceId, events: [syncCommand] });
  expect(syncBatchRequestSchema.safeParse({
    deviceId: partition.deviceId,
    events: Array.from({ length: 26 }, () => syncCommand),
  }).success).toBe(false);
  expect(syncBatchRequestSchema.safeParse({
    deviceId: partition.deviceId,
    events: [syncCommand, { ...syncCommand, sequence: 2 }],
  }).success).toBe(false);
  expect(syncBatchRequestSchema.safeParse({
    deviceId: partition.deviceId,
    events: [{ ...syncCommand, eventId: crypto.randomUUID() }, syncCommand],
  }).success).toBe(false);
});

it('keeps canonical confirmations distinct from recoverable and rejected results', () => {
  const confirmed = {
    eventId: syncCommand.eventId,
    status: 'confirmed' as const,
    canonicalId: syncCommand.aggregateId,
    confirmedAt: '2026-09-11T12:02:00.000Z',
  };
  expect(syncBatchResponseSchema.parse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [confirmed],
  }).results[0]).toEqual(confirmed);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [{ ...confirmed, status: 'rejected' }],
  }).success).toBe(false);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [confirmed, confirmed],
  }).success).toBe(false);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [{
      eventId: syncCommand.eventId,
      status: 'recoverable_error',
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Tente novamente.', recoverable: false },
    }],
  }).success).toBe(false);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [{
      eventId: syncCommand.eventId,
      status: 'recoverable_error',
      error: { code: 'FORBIDDEN', message: 'Operação negada.', recoverable: true },
    }],
  }).success).toBe(false);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [{
      eventId: syncCommand.eventId,
      status: 'rejected',
      error: { code: 'RATE_LIMITED', message: 'Limite atingido.', recoverable: false },
    }],
  }).success).toBe(false);
  expect(syncBatchResponseSchema.safeParse({
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    results: [{
      eventId: syncCommand.eventId,
      status: 'rejected',
      error: { code: 'VALIDATION_FAILED', message: 'Evento inválido.', recoverable: true },
    }],
  }).success).toBe(false);
  expect(syncBatchExchangeSchema.safeParse({
    request: { deviceId: partition.deviceId, events: [syncCommand] },
    response: {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      results: [{ ...confirmed, eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    },
  }).success).toBe(false);
});
