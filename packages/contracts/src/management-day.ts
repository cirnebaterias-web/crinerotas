import { z } from 'zod';

export const managementServiceDateSchema = z.iso.date();
export const managementExecutionStatusSchema = z.enum(['pending', 'in_visit', 'completed', 'not_visited']);
export const managementSyncStatusSchema = z.enum(['recoverable_error', 'action_required']);
export const managementSyncErrorCodeSchema = z.enum([
  'AUTH_REQUIRED', 'FORBIDDEN', 'VALIDATION_FAILED', 'VERSION_CONFLICT',
  'EVENT_OUT_OF_ORDER', 'IDEMPOTENCY_KEY_REUSED', 'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE', 'INTERNAL_ERROR',
]);

export const managementDayCountsSchema = z.object({
  planned: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  inVisit: z.number().int().nonnegative(), completed: z.number().int().nonnegative(),
  notVisited: z.number().int().nonnegative(),
}).strict().refine(
  (counts) => counts.planned === counts.pending + counts.inVisit + counts.completed + counts.notVisited,
  { message: 'O total planejado deve corresponder aos estados operacionais.' },
);

export const managementSyncSummarySchema = z.object({
  pending: z.number().int().nonnegative(), errors: z.number().int().nonnegative(),
  oldestPendingAt: z.iso.datetime({ offset: true }).nullable(),
  lastKnownAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const managementDaySyncIssueSchema = z.object({
  eventId: z.uuid(), status: managementSyncStatusSchema, errorCode: managementSyncErrorCodeSchema,
  occurredAt: z.iso.datetime({ offset: true }), lastObservedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayNonVisitSchema = z.object({
  routeVersionStopId: z.uuid(), clientId: z.uuid(), clientName: z.string().trim().min(1).max(160),
  reasonId: z.uuid(), updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayHistoricalExecutionSchema = z.object({
  routeVersionStopId: z.uuid(), clientId: z.uuid(), clientName: z.string().trim().min(1).max(160),
  status: managementExecutionStatusSchema.exclude(['pending']), updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementDayVisitReferenceSchema = z.object({
  visitId: z.uuid(), routeVersionStopId: z.uuid(),
  client: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(160) }).strict(),
  status: z.enum(['in_progress', 'completed']),
  deviceStartedAt: z.iso.datetime({ offset: true }), serverStartedAt: z.iso.datetime({ offset: true }),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }),
}).strict();

export const managementActivityStateSchema = z.enum([
  'confirmed', 'not_occurred', 'exception', 'unknown_to_server', 'withheld', 'action_required',
]);

export const managementVisitChecklistSchema = z.object({
  facadeCheckin: managementActivityStateSchema, checkout: managementActivityStateSchema,
  stock: managementActivityStateSchema, competitorPrices: managementActivityStateSchema,
  commercialActions: managementActivityStateSchema, scrap: managementActivityStateSchema,
  result: managementActivityStateSchema, synchronization: managementActivityStateSchema,
}).strict();

export const managementDayVisitSummarySchema = managementDayVisitReferenceSchema.extend({
  checklist: managementVisitChecklistSchema,
  exceptionCount: z.number().int().nonnegative().max(20),
}).strict();

export const managementDayStopSchema = z.object({
  routeVersionStopId: z.uuid(), plannedOrder: z.number().int().positive().max(50),
  executionOrder: z.number().int().positive().max(50), priority: z.number().int().min(0).max(9),
  client: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(160) }).strict(),
  status: managementExecutionStatusSchema,
  nonVisitReason: z.object({ id: z.uuid(), label: z.string().trim().min(1).max(160) }).strict().nullable(),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }),
  visits: z.array(managementDayVisitSummarySchema).max(10),
}).strict();

export const managementDayRouteSchema = z.object({
  routeId: z.uuid(), routeVersionId: z.uuid(), versionNumber: z.number().int().positive(),
  seller: z.object({ id: z.uuid(), displayName: z.string().trim().min(1).max(120) }).strict(),
  counts: managementDayCountsSchema, sync: managementSyncSummarySchema,
  nonVisits: z.array(managementDayNonVisitSchema).max(50),
  historicalExecutions: z.array(managementDayHistoricalExecutionSchema).max(50),
  syncIssues: z.array(managementDaySyncIssueSchema).max(100),
  visits: z.array(managementDayVisitReferenceSchema).max(50).default([]),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const managementDayRouteV2Schema = managementDayRouteSchema.extend({
  stops: z.array(managementDayStopSchema).max(50),
}).strict().superRefine((route, context) => {
  if (route.stops.length !== route.counts.planned) {
    context.addIssue({ code: 'custom', path: ['stops'], message: 'As paradas devem corresponder ao total planejado.' });
  }
  const stopIds = new Set<string>();
  const plannedOrders = new Set<number>();
  const executionOrders = new Set<number>();
  const nestedVisitIds = new Set<string>();
  route.stops.forEach((stop, stopIndex) => {
    if (stopIds.has(stop.routeVersionStopId)) {
      context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'routeVersionStopId'], message: 'Parada duplicada.' });
    }
    if (plannedOrders.has(stop.plannedOrder)) {
      context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'plannedOrder'], message: 'Ordem planejada duplicada.' });
    }
    if (executionOrders.has(stop.executionOrder)) {
      context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'executionOrder'], message: 'Ordem de execução duplicada.' });
    }
    stopIds.add(stop.routeVersionStopId);
    plannedOrders.add(stop.plannedOrder);
    executionOrders.add(stop.executionOrder);
    stop.visits.forEach((visit, visitIndex) => {
      if (visit.routeVersionStopId !== stop.routeVersionStopId) {
        context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'visits', visitIndex, 'routeVersionStopId'],
          message: 'A visita deve permanecer vinculada à parada de origem.' });
      }
      if (visit.client.id !== stop.client.id) {
        context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'visits', visitIndex, 'client', 'id'],
          message: 'O cliente da visita deve corresponder ao cliente da parada.' });
      }
      if (nestedVisitIds.has(visit.visitId)) {
        context.addIssue({ code: 'custom', path: ['stops', stopIndex, 'visits', visitIndex, 'visitId'],
          message: 'Visita duplicada entre as paradas.' });
      }
      nestedVisitIds.add(visit.visitId);
    });
  });
  route.visits.forEach((visit, visitIndex) => {
    if (!stopIds.has(visit.routeVersionStopId)) {
      context.addIssue({ code: 'custom', path: ['visits', visitIndex, 'routeVersionStopId'],
        message: 'A referência de visita deve pertencer a uma parada atual da rota.' });
    }
  });
  const stopCounts = route.stops.reduce((counts, stop) => ({
    ...counts,
    [stop.status]: counts[stop.status] + 1,
  }), { pending: 0, in_visit: 0, completed: 0, not_visited: 0 });
  const expected = {
    pending: route.counts.pending,
    in_visit: route.counts.inVisit,
    completed: route.counts.completed,
    not_visited: route.counts.notVisited,
  };
  for (const status of Object.keys(expected) as (keyof typeof expected)[]) {
    if (stopCounts[status] !== expected[status]) {
      context.addIssue({ code: 'custom', path: ['stops'], message: `Contagem incompatível para ${status}.` });
    }
  }
});

const responseBaseShape = {
  serviceDate: managementServiceDateSchema, generatedAt: z.iso.datetime({ offset: true }),
  lastKnownUpdateAt: z.iso.datetime({ offset: true }).nullable(), availability: z.enum(['empty', 'available']),
  totals: managementDayCountsSchema, sync: managementSyncSummarySchema,
  serverVisibilityNote: z.literal(
    'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
  ),
} as const;

type ResponseForTotals = {
  availability: 'empty' | 'available';
  totals: z.infer<typeof managementDayCountsSchema>; sync: z.infer<typeof managementSyncSummarySchema>;
  routes: Array<{ counts: z.infer<typeof managementDayCountsSchema>; sync: z.infer<typeof managementSyncSummarySchema> }>;
};

function validateTotals(value: ResponseForTotals, context: z.RefinementCtx) {
  if ((value.routes.length === 0) !== (value.availability === 'empty')) {
    context.addIssue({ code: 'custom', path: ['availability'], message: 'Disponibilidade incompatível com as rotas.' });
  }
  const totals = value.routes.reduce((result, route) => ({
    planned: result.planned + route.counts.planned, pending: result.pending + route.counts.pending,
    inVisit: result.inVisit + route.counts.inVisit, completed: result.completed + route.counts.completed,
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
}

export const managementDayResponseV1Schema = z.object({
  schemaVersion: z.literal(1), ...responseBaseShape, routes: z.array(managementDayRouteSchema).max(500),
}).strict().superRefine(validateTotals);

export const managementDayResponseV2Schema = z.object({
  schemaVersion: z.literal(2), ...responseBaseShape, routes: z.array(managementDayRouteV2Schema).max(500),
}).strict().superRefine(validateTotals);

export const managementDayResponseSchema = z.union([managementDayResponseV2Schema, managementDayResponseV1Schema]);

export type ManagementServiceDate = z.infer<typeof managementServiceDateSchema>;
export type ManagementDayCounts = z.infer<typeof managementDayCountsSchema>;
export type ManagementDayRoute = z.infer<typeof managementDayRouteSchema>;
export type ManagementDayRouteV2 = z.infer<typeof managementDayRouteV2Schema>;
export type ManagementDayResponse = z.infer<typeof managementDayResponseSchema>;
export type ManagementDaySyncIssue = z.infer<typeof managementDaySyncIssueSchema>;
export type ManagementDayStop = z.infer<typeof managementDayStopSchema>;
export type ManagementActivityState = z.infer<typeof managementActivityStateSchema>;

export const managementDayPath = '/api/v1/management/day';
