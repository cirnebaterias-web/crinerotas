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
  persistenceState: z.literal('saved_on_device'),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalVisitDraft = z.infer<typeof localVisitDraftSchema>;

export const offlineOutboxStatusSchema = z.enum([
  'pending',
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
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();
export type OfflineOutboxEvent = z.infer<typeof offlineOutboxEventSchema>;
