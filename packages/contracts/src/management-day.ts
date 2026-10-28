import { z } from 'zod';

export const managementServiceDateSchema = z.iso.date();
export const managementExecutionStatusSchema = z.enum([
  'pending',
  'in_visit',
  'completed',
  'not_visited',
]);
export const managementSyncStatusSchema = z.enum(['recoverable_error', 'action_required']);
export const managementSyncErrorCodeSchema = z.enum([
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

export const managementDayCountsSchema = z.object({
  planned: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  inVisit: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  notVisited: z.number().int().nonnegative(),
}).strict().refine(
  (counts) => counts.planned === counts.pending + counts.inVisit + counts.completed + counts.notVisited,
  { message: 'O total planejado deve corresponder aos estados operacionais.' },
);

export const managementSyncSummarySchema = z.object({
  pending: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  oldestPendingAt: z.iso.datetime({ offset: true }).nullable(),
  lastKnownAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const managementDaySyncIssueSchema = z.object({
  eventId: z.uuid(),
  status: managementSyncStatusSchema,
  errorCode: managementSyncErrorCodeSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  lastObservedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayNonVisitSchema = z.object({
  routeVersionStopId: z.uuid(),
  clientId: z.uuid(),
  clientName: z.string().trim().min(1).max(160),
  reasonId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayHistoricalExecutionSchema = z.object({
  routeVersionStopId: z.uuid(),
  clientId: z.uuid(),
  clientName: z.string().trim().min(1).max(160),
  status: managementExecutionStatusSchema.exclude(['pending']),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayVisitReferenceSchema = z.object({
  visitId: z.uuid(),
  routeVersionStopId: z.uuid(),
  client: z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(160),
  }).strict(),
  status: z.enum(['in_progress', 'completed']),
  deviceStartedAt: z.iso.datetime({ offset: true }),
  serverStartedAt: z.iso.datetime({ offset: true }),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayRouteSchema = z.object({
  routeId: z.uuid(),
  routeVersionId: z.uuid(),
  versionNumber: z.number().int().positive(),
  seller: z.object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(120),
  }).strict(),
  counts: managementDayCountsSchema,
  sync: managementSyncSummarySchema,
  nonVisits: z.array(managementDayNonVisitSchema).max(50),
  historicalExecutions: z.array(managementDayHistoricalExecutionSchema).max(50),
  syncIssues: z.array(managementDaySyncIssueSchema).max(100),
  visits: z.array(managementDayVisitReferenceSchema).max(50).default([]),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const managementDayResponseSchema = z.object({
  schemaVersion: z.literal(1),
  serviceDate: managementServiceDateSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }).nullable(),
  availability: z.enum(['empty', 'available']),
  totals: managementDayCountsSchema,
  sync: managementSyncSummarySchema,
  routes: z.array(managementDayRouteSchema).max(500),
  serverVisibilityNote: z.literal(
    'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
  ),
}).strict().superRefine((value, context) => {
  if ((value.routes.length === 0) !== (value.availability === 'empty')) {
    context.addIssue({ code: 'custom', path: ['availability'], message: 'Disponibilidade incompatível com as rotas.' });
  }
  const totals = value.routes.reduce((result, route) => ({
    planned: result.planned + route.counts.planned,
    pending: result.pending + route.counts.pending,
    inVisit: result.inVisit + route.counts.inVisit,
    completed: result.completed + route.counts.completed,
    notVisited: result.notVisited + route.counts.notVisited,
  }), { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 });
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
    if (totals[key] !== value.totals[key]) {
      context.addIssue({ code: 'custom', path: ['totals', key], message: 'Total incompatível com as rotas.' });
    }
  }
  const pending = value.routes.reduce((sum, route) => sum + route.sync.pending, 0);
  const errors = value.routes.reduce((sum, route) => sum + route.sync.errors, 0);
  if (pending !== value.sync.pending || errors !== value.sync.errors) {
    context.addIssue({ code: 'custom', path: ['sync'], message: 'Sincronização incompatível com as rotas.' });
  }
});

export type ManagementServiceDate = z.infer<typeof managementServiceDateSchema>;
export type ManagementDayCounts = z.infer<typeof managementDayCountsSchema>;
export type ManagementDayRoute = z.infer<typeof managementDayRouteSchema>;
export type ManagementDayResponse = z.infer<typeof managementDayResponseSchema>;
export type ManagementDaySyncIssue = z.infer<typeof managementDaySyncIssueSchema>;

export const managementDayPath = '/api/v1/management/day';
