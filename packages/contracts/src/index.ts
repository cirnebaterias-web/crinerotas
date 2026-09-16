import { z } from 'zod';

export const liveResponseSchema = z.object({ status: z.literal('ok') }).strict();
export type LiveResponse = z.infer<typeof liveResponseSchema>;
export const livePath = '/api/v1/health/live';

export const roleCodeSchema = z.enum(['seller', 'manager', 'administrator']);
export const userStatusSchema = z.enum(['active', 'inactive']);
export const meResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(roleCodeSchema),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)),
  scopeIds: z.array(z.uuid()),
  status: userStatusSchema,
}).strict();
export type MeResponse = z.infer<typeof meResponseSchema>;
export const mePath = '/api/v1/me';

export const routesPath = '/api/v1/routes';
export const myTodayRoutePath = '/api/v1/me/routes/today';
export const routePath = (routeId: string) => `${routesPath}/${routeId}`;
export const routePublishPath = (routeId: string) => `${routePath(routeId)}/publish`;
export const routeExecutionOrderPath = (routeId: string) => `${routePath(routeId)}/execution-order`;

export const routeErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type RouteErrorCode = z.infer<typeof routeErrorCodeSchema>;

export const routeStopInputSchema = z.object({
  clientId: z.uuid(),
  plannedOrder: z.number().int().positive().max(50),
  priority: z.number().int().min(0).max(9),
}).strict();

export const createRouteDraftRequestSchema = z.object({
  schemaVersion: z.literal(1),
  serviceDate: z.iso.date(),
  sellerId: z.uuid(),
  stops: z.array(routeStopInputSchema).min(1).max(50),
}).strict().superRefine(({ stops }, context) => {
  const clients = new Set<string>();
  const orders = new Set<number>();
  stops.forEach((stop, index) => {
    if (clients.has(stop.clientId)) {
      context.addIssue({ code: 'custom', path: ['stops', index, 'clientId'], message: 'Cliente repetido na rota.' });
    }
    if (orders.has(stop.plannedOrder)) {
      context.addIssue({ code: 'custom', path: ['stops', index, 'plannedOrder'], message: 'Ordem planejada repetida.' });
    }
    clients.add(stop.clientId);
    orders.add(stop.plannedOrder);
  });
});
export type CreateRouteDraftRequest = z.infer<typeof createRouteDraftRequestSchema>;

export const routeDraftStopSchema = routeStopInputSchema.extend({
  routeVersionStopId: z.uuid(),
}).strict();
export const routeDraftSchema = z.object({
  schemaVersion: z.literal(1),
  routeId: z.uuid(),
  routeVersionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  serviceDate: z.iso.date(),
  sellerId: z.uuid(),
  status: z.literal('draft'),
  stops: z.array(routeDraftStopSchema).min(1).max(50),
}).strict();
export type RouteDraft = z.infer<typeof routeDraftSchema>;

export const publishRouteRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().positive(),
}).strict();
export type PublishRouteRequest = z.infer<typeof publishRouteRequestSchema>;

export const routePublicationSchema = z.object({
  schemaVersion: z.literal(1),
  routeId: z.uuid(),
  routeVersionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  status: z.literal('published'),
  publishedBy: z.uuid(),
  publishedAt: z.iso.datetime({ offset: true }),
  stopCount: z.number().int().positive().max(50),
}).strict();
export type RoutePublication = z.infer<typeof routePublicationSchema>;

export const reorderRouteExecutionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().positive(),
  pendingStopIds: z.array(z.uuid()).min(1).max(50).superRefine((stopIds, context) => {
    const seen = new Set<string>();
    stopIds.forEach((stopId, index) => {
      if (seen.has(stopId)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Parada repetida na ordem de execução.',
        });
      }
      seen.add(stopId);
    });
  }),
}).strict();
export type ReorderRouteExecutionRequest = z.infer<typeof reorderRouteExecutionRequestSchema>;

export const reorderRouteExecutionResultSchema = z.object({
  schemaVersion: z.literal(1),
  routeId: z.uuid(),
  routeVersionId: z.uuid(),
  executionVersion: z.number().int().positive(),
  changed: z.boolean(),
  pendingStopIds: z.array(z.uuid()).min(1).max(50),
}).strict();
export type ReorderRouteExecutionResult = z.infer<typeof reorderRouteExecutionResultSchema>;

const nullableDecimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/).nullable();
export const routeSellerSnapshotSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(120),
}).strict();
export const routeClientSnapshotSchema = z.object({
  id: z.uuid(),
  externalReference: z.string().trim().min(1).max(120).nullable(),
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300),
  latitude: nullableDecimalSchema,
  longitude: nullableDecimalSchema,
  portfolioReference: z.string().trim().min(1).max(120).nullable(),
}).strict();
export const canonicalRouteStopSchema = z.object({
  routeVersionStopId: z.uuid(),
  plannedOrder: z.number().int().positive().max(50),
  executionOrder: z.number().int().positive().max(50),
  priority: z.number().int().min(0).max(9),
  status: z.enum(['pending', 'in_visit', 'completed', 'not_visited']),
  executionVersion: z.number().int().positive(),
  client: routeClientSnapshotSchema,
}).strict();
export const canonicalRouteSchema = z.object({
  schemaVersion: z.literal(2),
  routeId: z.uuid(),
  routeVersionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  serviceDate: z.iso.date(),
  status: z.literal('published'),
  publishedAt: z.iso.datetime({ offset: true }),
  executionVersion: z.number().int().positive(),
  seller: routeSellerSnapshotSchema,
  stops: z.array(canonicalRouteStopSchema).min(1).max(50),
}).strict();
export type CanonicalRoute = z.infer<typeof canonicalRouteSchema>;

export const routeTodayResponseSchema = z.discriminatedUnion('availability', [
  z.object({
    schemaVersion: z.literal(2),
    availability: z.literal('empty'),
    serviceDate: z.iso.date(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    availability: z.literal('available'),
    route: canonicalRouteSchema,
  }).strict(),
]);
export type RouteTodayResponse = z.infer<typeof routeTodayResponseSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    recoverable: z.boolean(),
    timestamp: z.iso.datetime({ offset: true }),
    requestId: z.uuid(),
  }).strict(),
}).strict();
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export const maxSyncBatchEvents = 25;
export const syncBatchPath = '/api/v1/sync/batches';
export const syncOperationSchema = z.literal('visit.draft.saved');
export const syncAggregateTypeSchema = z.literal('visit_draft');
export const syncErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'EVENT_OUT_OF_ORDER',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type SyncErrorCode = z.infer<typeof syncErrorCodeSchema>;

export const syncCommandSchema = z.object({
  eventId: z.uuid(),
  idempotencyKey: z.uuid(),
  operation: syncOperationSchema,
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  aggregateType: syncAggregateTypeSchema,
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.object({
    draftOfflineId: z.uuid(),
    routeVersionStopId: z.uuid(),
    acknowledged: z.boolean(),
  }).strict(),
}).strict().superRefine((command, context) => {
  if (command.aggregateId !== command.payload.draftOfflineId) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'draftOfflineId'],
      message: 'O agregado deve corresponder ao rascunho do payload.',
    });
  }
});
export type SyncCommand = z.infer<typeof syncCommandSchema>;

export const syncBatchRequestSchema = z.object({
  deviceId: z.uuid(),
  events: z.array(syncCommandSchema).min(1).max(maxSyncBatchEvents).superRefine((events, context) => {
    const eventIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    events.forEach((event, index) => {
      if (eventIds.has(event.eventId)) {
        context.addIssue({ code: 'custom', path: [index, 'eventId'], message: 'eventId duplicado no lote.' });
      }
      if (idempotencyKeys.has(event.idempotencyKey)) {
        context.addIssue({ code: 'custom', path: [index, 'idempotencyKey'], message: 'idempotencyKey duplicada no lote.' });
      }
      eventIds.add(event.eventId);
      idempotencyKeys.add(event.idempotencyKey);
    });
  }),
}).strict();
export type SyncBatchRequest = z.infer<typeof syncBatchRequestSchema>;

export const syncEventErrorSchema = z.object({
  code: syncErrorCodeSchema,
  message: z.string().trim().min(1).max(240),
  recoverable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type SyncEventError = z.infer<typeof syncEventErrorSchema>;

export const recoverableSyncErrorCodeSchema = z.enum([
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export const rejectedSyncErrorCodeSchema = z.enum([
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'EVENT_OUT_OF_ORDER',
  'IDEMPOTENCY_KEY_REUSED',
]);

const confirmedSyncResultSchema = z.object({
  eventId: z.uuid(),
  status: z.literal('confirmed'),
  canonicalId: z.uuid(),
  confirmedAt: z.iso.datetime({ offset: true }),
}).strict();
const recoverableSyncResultSchema = z.object({
  eventId: z.uuid(),
  status: z.literal('recoverable_error'),
  error: syncEventErrorSchema.extend({
    code: recoverableSyncErrorCodeSchema,
    recoverable: z.literal(true),
  }),
}).strict();
const rejectedSyncResultSchema = z.object({
  eventId: z.uuid(),
  status: z.literal('rejected'),
  error: syncEventErrorSchema.extend({
    code: rejectedSyncErrorCodeSchema,
    recoverable: z.literal(false),
  }),
}).strict();
export const syncResultSchema = z.discriminatedUnion('status', [
  confirmedSyncResultSchema,
  recoverableSyncResultSchema,
  rejectedSyncResultSchema,
]);
export type SyncResult = z.infer<typeof syncResultSchema>;

export const syncBatchResponseSchema = z.object({
  requestId: z.uuid(),
  results: z.array(syncResultSchema).min(1).max(maxSyncBatchEvents).superRefine((results, context) => {
    const seen = new Set<string>();
    results.forEach((result, index) => {
      if (seen.has(result.eventId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'eventId'],
          message: 'Cada evento deve possuir exatamente um resultado.',
        });
      }
      seen.add(result.eventId);
    });
  }),
}).strict();
export type SyncBatchResponse = z.infer<typeof syncBatchResponseSchema>;

export const syncBatchExchangeSchema = z.object({
  request: syncBatchRequestSchema,
  response: syncBatchResponseSchema,
}).strict().superRefine(({ request, response }, context) => {
  const requestedIds = new Set(request.events.map(({ eventId }) => eventId));
  if (response.results.length !== requestedIds.size) {
    context.addIssue({ code: 'custom', path: ['response', 'results'], message: 'Quantidade de resultados divergente do lote.' });
  }
  response.results.forEach((result, index) => {
    if (!requestedIds.has(result.eventId)) {
      context.addIssue({
        code: 'custom',
        path: ['response', 'results', index, 'eventId'],
        message: 'Resultado não pertence ao lote solicitado.',
      });
    }
  });
});

export const offlineSchemaVersion = 1 as const;
export const offlineSchemaVersionSchema = z.literal(offlineSchemaVersion);

export const offlinePartitionSchema = z.object({
  userId: z.uuid(),
  deviceId: z.uuid(),
}).strict();
export type OfflinePartition = z.infer<typeof offlinePartitionSchema>;

export const syntheticRouteStopSchema = z.object({
  routeVersionStopId: z.uuid(),
  displayLabel: z.string().trim().min(1).max(80),
  executionOrder: z.number().int().positive(),
  priority: z.number().int().min(0).max(9),
}).strict();

export const localRouteBundleSchema = z.object({
  schemaVersion: offlineSchemaVersionSchema,
  userId: z.uuid(),
  deviceId: z.uuid(),
  routeId: z.uuid(),
  routeVersion: z.number().int().positive(),
  parameterSetVersion: z.number().int().positive(),
  serviceDate: z.iso.date(),
  stops: z.array(syntheticRouteStopSchema).min(1).max(50),
  cachedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalRouteBundle = z.infer<typeof localRouteBundleSchema>;

export const localSessionSchema = z.object({
  schemaVersion: offlineSchemaVersionSchema,
  userId: z.uuid(),
  deviceId: z.uuid(),
  validatedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
  lastObservedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalSession = z.infer<typeof localSessionSchema>;

export const localPersistenceStateSchema = z.enum([
  'saved_on_device',
  'pending',
  'recoverable_error',
  'action_required',
  'synced',
]);
export type LocalPersistenceState = z.infer<typeof localPersistenceStateSchema>;

export const localVisitDraftSchema = z.object({
  schemaVersion: offlineSchemaVersionSchema,
  offlineId: z.uuid(),
  userId: z.uuid(),
  deviceId: z.uuid(),
  routeVersionStopId: z.uuid(),
  currentStep: z.literal('start'),
  acknowledged: z.boolean(),
  localStatus: z.literal('draft'),
  persistenceState: z.enum(['saved_on_device', 'synced']),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalVisitDraft = z.infer<typeof localVisitDraftSchema>;

export const offlineOutboxStatusSchema = z.enum([
  'pending',
  'sending',
  'recoverable_error',
  'action_required',
]);
export type OfflineOutboxStatus = z.infer<typeof offlineOutboxStatusSchema>;

export const draftSavedPayloadSchema = z.object({
  draftOfflineId: z.uuid(),
  routeVersionStopId: z.uuid(),
  acknowledged: z.boolean(),
}).strict();

export const offlineOutboxEventSchema = z.object({
  schemaVersion: offlineSchemaVersionSchema,
  userId: z.uuid(),
  deviceId: z.uuid(),
  eventId: z.uuid(),
  idempotencyKey: z.uuid(),
  operation: z.literal('visit.draft.saved'),
  aggregateId: z.uuid(),
  sequence: z.number().int().positive(),
  payload: draftSavedPayloadSchema,
  status: offlineOutboxStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: syncErrorCodeSchema.optional(),
  nextAttemptAt: z.iso.datetime({ offset: true }).optional(),
  leaseUntil: z.iso.datetime({ offset: true }).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();
export type OfflineOutboxEvent = z.infer<typeof offlineOutboxEventSchema>;
