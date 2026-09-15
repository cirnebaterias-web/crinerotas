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
