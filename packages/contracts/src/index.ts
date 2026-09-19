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
export const authSessionPath = '/api/v1/auth/session';
const passwordSchema = z.string().min(1).max(256);
export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: passwordSchema,
}).strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

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

export const changeRouteCompositionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  stops: z.array(routeStopInputSchema).min(1).max(50),
}).strict().superRefine(({ stops }, context) => {
  const clients = new Set<string>();
  const orders = new Set<number>();
  stops.forEach((stop, index) => {
    const clientId = stop.clientId.toLowerCase();
    if (clients.has(clientId)) {
      context.addIssue({ code: 'custom', path: ['stops', index, 'clientId'], message: 'Cliente repetido na rota.' });
    }
    if (orders.has(stop.plannedOrder)) {
      context.addIssue({ code: 'custom', path: ['stops', index, 'plannedOrder'], message: 'Ordem planejada repetida.' });
    }
    clients.add(clientId);
    orders.add(stop.plannedOrder);
  });
});
export type ChangeRouteCompositionRequest = z.infer<typeof changeRouteCompositionRequestSchema>;

export const routeCompositionDiffSchema = z.object({
  addedClientIds: z.array(z.uuid()).max(50),
  removedClientIds: z.array(z.uuid()).max(50),
  retainedClientIds: z.array(z.uuid()).max(50),
}).strict();
export type RouteCompositionDiff = z.infer<typeof routeCompositionDiffSchema>;

export const routeCompositionDraftSchema = routeDraftSchema.extend({
  changed: z.boolean(),
  changeReason: z.string().trim().min(1).max(500),
  changeSummary: routeCompositionDiffSchema,
}).strict();
export type RouteCompositionDraft = z.infer<typeof routeCompositionDraftSchema>;

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
  pendingStopIds: z.array(z.uuid().transform((id) => id.toLowerCase())).min(1).max(50).superRefine((stopIds, context) => {
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
export const canonicalRouteV2Schema = z.object({
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
export const routeCompositionChangedClientSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(160),
}).strict();
export const routeCompositionChangeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  previousVersionNumber: z.number().int().positive(),
  added: z.array(routeCompositionChangedClientSchema).max(50),
  removed: z.array(routeCompositionChangedClientSchema).max(50),
}).strict();
export type RouteCompositionChange = z.infer<typeof routeCompositionChangeSchema>;
export const canonicalRouteV3Schema = canonicalRouteV2Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(3),
  compositionChange: routeCompositionChangeSchema.nullable(),
}).strict();
export const canonicalRouteSchema = z.discriminatedUnion('schemaVersion', [
  canonicalRouteV2Schema,
  canonicalRouteV3Schema,
]);
export type CanonicalRoute = z.infer<typeof canonicalRouteSchema>;

export const routeTodayResponseSchema = z.union([
  z.object({
    schemaVersion: z.literal(2),
    availability: z.literal('empty'),
    serviceDate: z.iso.date(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(2),
    availability: z.literal('available'),
    route: canonicalRouteV2Schema,
  }).strict(),
  z.object({
    schemaVersion: z.literal(3),
    availability: z.literal('empty'),
    serviceDate: z.iso.date(),
  }).strict(),
  z.object({
    schemaVersion: z.literal(3),
    availability: z.literal('available'),
    route: canonicalRouteV3Schema,
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
export const visitsPath = '/api/v1/visits';
export const visitStockPath = (offlineId: string) => `${visitsPath}/${offlineId}/sections/stock`;
export const visitCsrfToken = 'cirne-visit-v1';

const canonicalDecimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/);
const nonNegativeDecimalSchema = z.string().regex(/^\d+(\.\d+)?$/);

export const visitStartLocationSchema = z.object({
  latitude: canonicalDecimalSchema.refine((value) => Math.abs(Number(value)) <= 90),
  longitude: canonicalDecimalSchema.refine((value) => Math.abs(Number(value)) <= 180),
  accuracyM: nonNegativeDecimalSchema.optional(),
  distanceM: nonNegativeDecimalSchema.optional(),
}).strict();
export type VisitStartLocation = z.infer<typeof visitStartLocationSchema>;

export const startVisitRequestSchema = z.object({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  routeVersionStopId: z.uuid(),
  deviceStartedAt: z.iso.datetime({ offset: true }),
  location: visitStartLocationSchema.optional(),
}).strict();
export type StartVisitRequest = z.infer<typeof startVisitRequestSchema>;

export const visitContextSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sourceRouteVersionId: z.uuid(),
  snapshotCreatedAt: z.iso.datetime({ offset: true }),
  route: z.object({
    id: z.uuid(),
    versionNumber: z.number().int().positive(),
    serviceDate: z.iso.date(),
    publishedAt: z.iso.datetime({ offset: true }),
    plannedOrder: z.number().int().positive().max(50),
    priority: z.number().int().min(0).max(9),
  }).strict(),
  client: routeClientSnapshotSchema,
  seller: routeSellerSnapshotSchema,
  parameters: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict(),
}).strict();
export type VisitContextSnapshot = z.infer<typeof visitContextSnapshotSchema>;

export const visitStartResultSchema = z.object({
  schemaVersion: z.literal(1),
  visitId: z.uuid(),
  offlineId: z.uuid(),
  deviceId: z.uuid(),
  routeVersionStopId: z.uuid(),
  routeVersionId: z.uuid(),
  clientId: z.uuid(),
  sellerId: z.uuid(),
  parameterSetId: z.uuid(),
  status: z.literal('in_progress'),
  contextSnapshot: visitContextSnapshotSchema,
  deviceStartedAt: z.iso.datetime({ offset: true }),
  serverStartedAt: z.iso.datetime({ offset: true }),
}).strict();
export type VisitStartResult = z.infer<typeof visitStartResultSchema>;

const stockObservationSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() || undefined : value,
  z.string().max(500).optional(),
);

export const stockInputSchema = z.object({
  heliarQuantity: z.number().int().nonnegative(),
  mouraQuantity: z.number().int().nonnegative(),
  observation: stockObservationSchema,
}).strict();
export type StockInput = z.infer<typeof stockInputSchema>;

export const saveStockRequestSchema = stockInputSchema.extend({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  deviceSavedAt: z.iso.datetime({ offset: true }),
}).strict();
export type SaveStockRequest = z.infer<typeof saveStockRequestSchema>;

export const stockSnapshotResultSchema = stockInputSchema.extend({
  schemaVersion: z.literal(1),
  stockSnapshotId: z.uuid(),
  visitId: z.uuid(),
  offlineId: z.uuid(),
  serverSavedAt: z.iso.datetime({ offset: true }),
}).strict();
export type StockSnapshotResult = z.infer<typeof stockSnapshotResultSchema>;

export const visitErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'EVENT_OUT_OF_ORDER',
  'IDEMPOTENCY_KEY_REUSED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type VisitErrorCode = z.infer<typeof visitErrorCodeSchema>;

export const visitStartedPayloadSchema = startVisitRequestSchema.omit({ schemaVersion: true }).extend({
  // Present only in the TypeScript shape so legacy consumers can narrow safely.
  acknowledged: z.never().optional(),
}).strict();
export type VisitStartedPayload = z.infer<typeof visitStartedPayloadSchema>;

export const visitStockSavedPayloadSchema = saveStockRequestSchema.omit({ schemaVersion: true }).strict();
export type VisitStockSavedPayload = z.infer<typeof visitStockSavedPayloadSchema>;

export const syncOperationSchema = z.enum(['visit.draft.saved', 'visit.started.v1', 'visit.stock.saved.v1']);
export const syncAggregateTypeSchema = z.enum(['visit_draft', 'visit']);
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

const syncCommandBaseSchema = z.object({
  eventId: z.uuid(),
  idempotencyKey: z.uuid(),
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  aggregateId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
});

const legacyDraftSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.draft.saved'),
  aggregateType: z.literal('visit_draft'),
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

const visitStartedSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.started.v1'),
  aggregateType: z.literal('visit'),
  payload: visitStartedPayloadSchema,
}).strict().superRefine((command, context) => {
  if (command.sequence !== 1) {
    context.addIssue({
      code: 'custom',
      path: ['sequence'],
      message: 'O início deve ser o primeiro evento da visita.',
    });
  }
  if (command.aggregateId !== command.payload.offlineId) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'offlineId'],
      message: 'O agregado deve corresponder ao offlineId da visita.',
    });
  }
  if (command.occurredAt !== command.payload.deviceStartedAt) {
    context.addIssue({
      code: 'custom',
      path: ['occurredAt'],
      message: 'O horário do evento deve corresponder ao início no aparelho.',
    });
  }
});

const visitStockSavedSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.stock.saved.v1'),
  aggregateType: z.literal('visit'),
  payload: visitStockSavedPayloadSchema,
}).strict().superRefine((command, context) => {
  if (command.sequence < 2) {
    context.addIssue({
      code: 'custom',
      path: ['sequence'],
      message: 'O estoque exige o início anterior da visita.',
    });
  }
  if (command.aggregateId !== command.payload.offlineId) {
    context.addIssue({
      code: 'custom',
      path: ['payload', 'offlineId'],
      message: 'O agregado deve corresponder ao offlineId da visita.',
    });
  }
  if (command.occurredAt !== command.payload.deviceSavedAt) {
    context.addIssue({
      code: 'custom',
      path: ['occurredAt'],
      message: 'O horário do evento deve corresponder ao salvamento no aparelho.',
    });
  }
});

export const syncCommandSchema = z.discriminatedUnion('operation', [
  legacyDraftSyncCommandSchema,
  visitStartedSyncCommandSchema,
  visitStockSavedSyncCommandSchema,
]);
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

export const canonicalLocalRouteBundleSchema = canonicalRouteV2Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  userId: z.uuid(),
  deviceId: z.uuid(),
  cachedAt: z.iso.datetime({ offset: true }),
}).strict();
export type CanonicalLocalRouteBundle = z.infer<typeof canonicalLocalRouteBundleSchema>;

export const canonicalLocalRouteBundleV3Schema = canonicalRouteV3Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(3),
  userId: z.uuid(),
  deviceId: z.uuid(),
  cachedAt: z.iso.datetime({ offset: true }),
}).strict();
export type CanonicalLocalRouteBundleV3 = z.infer<typeof canonicalLocalRouteBundleV3Schema>;
export type AnyCanonicalLocalRouteBundle = CanonicalLocalRouteBundle | CanonicalLocalRouteBundleV3;

export const offlineRouteBundleSchema = z.discriminatedUnion('schemaVersion', [
  localRouteBundleSchema,
  canonicalLocalRouteBundleSchema,
  canonicalLocalRouteBundleV3Schema,
]);
export type OfflineRouteBundle = z.infer<typeof offlineRouteBundleSchema>;

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
  currentStep: z.enum(['start', 'stock', 'prices']),
  acknowledged: z.boolean().optional(),
  deviceStartedAt: z.iso.datetime({ offset: true }).optional(),
  client: routeClientSnapshotSchema.optional(),
  canonicalVisitId: z.uuid().optional(),
  serverStartedAt: z.iso.datetime({ offset: true }).optional(),
  lastConfirmedSequence: z.number().int().positive().optional(),
  stock: stockInputSchema.extend({
    eventId: z.uuid(),
    deviceSavedAt: z.iso.datetime({ offset: true }),
    serverSavedAt: z.iso.datetime({ offset: true }).optional(),
    persistenceState: z.enum(['saved_on_device', 'synced']),
  }).strict().optional(),
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

const offlineOutboxBaseSchema = z.object({
  schemaVersion: offlineSchemaVersionSchema,
  userId: z.uuid(),
  deviceId: z.uuid(),
  eventId: z.uuid(),
  idempotencyKey: z.uuid(),
  aggregateId: z.uuid(),
  sequence: z.number().int().positive(),
  status: offlineOutboxStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: syncErrorCodeSchema.optional(),
  nextAttemptAt: z.iso.datetime({ offset: true }).optional(),
  leaseUntil: z.iso.datetime({ offset: true }).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
});

const legacyOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.draft.saved'),
  payload: draftSavedPayloadSchema,
}).strict();

const visitStartedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.started.v1'),
  payload: visitStartedPayloadSchema,
}).strict();

const visitStockSavedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.stock.saved.v1'),
  payload: visitStockSavedPayloadSchema,
}).strict();

export const offlineOutboxEventSchema = z.discriminatedUnion('operation', [
  legacyOfflineOutboxEventSchema,
  visitStartedOfflineOutboxEventSchema,
  visitStockSavedOfflineOutboxEventSchema,
]);
export type OfflineOutboxEvent = z.infer<typeof offlineOutboxEventSchema>;
