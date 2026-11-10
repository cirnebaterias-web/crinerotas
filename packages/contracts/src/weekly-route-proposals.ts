import { z } from 'zod';

const coordinateSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();

const weeklyRoutePolicyWeightsSchema = z.object({
  recency: z.literal(50), volume: z.literal(15), scrapDebt: z.literal(20), proximity: z.literal(15),
}).strict();

const legacyWeeklyRoutePolicySchema = z.object({
  version: z.literal('weekly-route-rules-v2'),
  inactiveAfterDays: z.literal(180),
  dailyClientLimit: z.literal(10),
  dailyGpsMaxAgeMinutes: z.literal(5),
  dailyGpsMaxAccuracyM: z.literal(100),
  weights: weeklyRoutePolicyWeightsSchema,
}).strict();

export const currentWeeklyRoutePolicySchema = legacyWeeklyRoutePolicySchema.extend({
  version: z.literal('weekly-route-rules-v3'),
  coverageCadenceDays: z.literal(28),
  tripFromBaseDistanceKm: z.literal(80),
}).strict();

export const weeklyRoutePolicySchema = z.discriminatedUnion('version', [
  legacyWeeklyRoutePolicySchema, currentWeeklyRoutePolicySchema,
]);
export type WeeklyRoutePolicy = z.infer<typeof weeklyRoutePolicySchema>;

export const weeklyRouteBaseCityOriginSchema = coordinateSchema.extend({
  kind: z.literal('base_city'),
  city: z.string().trim().min(2).max(120),
  state: z.string().regex(/^[A-Z]{2}$/),
  ibgeCode: z.string().regex(/^\d{7}$/),
  reference: z.literal('municipal_seat'),
  source: z.literal('IBGE'),
  configVersion: z.number().int().positive(),
  sellerId: z.uuid(),
}).strict();
export type WeeklyRouteBaseCityOrigin = z.infer<typeof weeklyRouteBaseCityOriginSchema>;

export const currentGpsRouteOriginSchema = coordinateSchema.extend({
  kind: z.literal('current_gps'),
  capturedAt: z.iso.datetime({ offset: true }),
  accuracyM: z.number().finite().nonnegative().max(10_000),
  sellerId: z.uuid(),
}).strict();
export type CurrentGpsRouteOrigin = z.infer<typeof currentGpsRouteOriginSchema>;

export const routeProposalOriginSchema = z.discriminatedUnion('kind', [
  weeklyRouteBaseCityOriginSchema, currentGpsRouteOriginSchema,
]);
export type RouteProposalOrigin = z.infer<typeof routeProposalOriginSchema>;

export const weeklyRouteStrategyPreferenceSchema = z.enum(['auto', 'local', 'trip']);
export type WeeklyRouteStrategyPreference = z.infer<typeof weeklyRouteStrategyPreferenceSchema>;

export const weeklyRouteProposalRequestSchema = z.object({
  schemaVersion: z.literal(1), weekStart: z.iso.date(), sellerId: z.uuid(),
  strategyPreference: weeklyRouteStrategyPreferenceSchema.optional(),
}).strict();
export type WeeklyRouteProposalRequest = z.infer<typeof weeklyRouteProposalRequestSchema>;

export const weeklyRouteCandidateSchema = z.object({
  clientId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  status: z.enum(['active', 'inactive', 'pending_review']),
  daysSinceLastPurchase: z.number().int().nonnegative().nullable(),
  periodicityDays: z.number().positive().nullable(),
  averageMonthlyVolume: z.number().finite().nonnegative().nullable(),
  recentVolume3: z.number().finite().nullable().default(null),
  previousVolume3: z.number().finite().nullable().default(null),
  opportunitySegments: z.array(z.enum(['first_line', 'second_line', 'motorcycle', 'heavy'])).max(4).default([]),
  scrapDebtKg: z.number().finite().nonnegative().nullable(),
  scrapBalanceState: z.enum(['debtor', 'creditor', 'settled', 'unavailable']).default('unavailable'),
  location: coordinateSchema.nullable(),
  hasNavigableAddress: z.boolean(),
  visitHistoryStatus: z.enum(['available', 'unavailable']).default('unavailable'),
  lastCompletedVisitAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict();
export type WeeklyRouteCandidate = z.infer<typeof weeklyRouteCandidateSchema>;

export const weeklyRoutePlanningCandidateSchema = weeklyRouteCandidateSchema.extend({
  score: z.number().finite().nonnegative(),
  distanceFromBaseKm: z.number().finite().nonnegative().nullable(),
  cycleDelayDays: z.number().finite().nonnegative().nullable(),
  cycleDelayPercent: z.number().finite().nonnegative().nullable(),
  purchaseTrend: z.enum(['growing', 'falling', 'stable', 'unavailable']),
  potential: z.enum(['high', 'medium', 'standard']),
  coverageState: z.enum(['never_visited', 'overdue', 'due_this_week', 'covered', 'unavailable']),
  coverageOverdueDays: z.number().int().nonnegative().nullable(),
  nextVisitDueOn: z.iso.date().nullable(),
  reasons: z.array(z.string().min(1).max(180)).min(1).max(8),
}).strict();
export type WeeklyRoutePlanningCandidate = z.infer<typeof weeklyRoutePlanningCandidateSchema>;

export const weeklyRoutePlanningResponseSchema = z.object({
  schemaVersion: z.literal(1),
  weekStart: z.iso.date(),
  sellerId: z.uuid(),
  origin: weeklyRouteBaseCityOriginSchema,
  generatedAt: z.iso.datetime({ offset: true }),
  maxLegDistanceKm: z.literal(30),
  candidates: z.array(weeklyRoutePlanningCandidateSchema).max(5000),
  counts: z.object({ total: z.number().int().nonnegative(), eligible: z.number().int().nonnegative(),
    positioned: z.number().int().nonnegative(), inactiveLost: z.number().int().nonnegative() }).strict(),
}).strict();
export type WeeklyRoutePlanningResponse = z.infer<typeof weeklyRoutePlanningResponseSchema>;

export const weeklyRouteExclusionReasonSchema = z.enum([
  'inactive_lost', 'no_purchase_history', 'client_not_active', 'no_navigable_location',
  'daily_distance_limit', 'daily_capacity_reached', 'weekly_strategy_mismatch',
]);
export type WeeklyRouteExclusionReason = z.infer<typeof weeklyRouteExclusionReasonSchema>;

export const weeklyRouteSuggestionSchema = z.object({
  clientId: z.uuid(), name: z.string(), dayIndex: z.number().int().min(0).max(4),
  plannedOrder: z.number().int().min(1).max(10), score: z.number().finite().nonnegative(),
  approximateDistanceKm: z.number().finite().nonnegative().nullable(),
  reasons: z.array(z.string().min(1).max(180)).min(1).max(8),
  scrapBalanceState: z.enum(['debtor', 'creditor', 'settled', 'unavailable']),
  locationPending: z.boolean(),
  lastCompletedVisitAt: z.iso.datetime({ offset: true }).nullable().default(null),
  coverageState: z.enum(['never_visited', 'overdue', 'due_this_week', 'covered', 'unavailable'])
    .default('unavailable'),
  coverageOverdueDays: z.number().int().nonnegative().nullable().default(null),
  nextVisitDueOn: z.iso.date().nullable().default(null),
}).strict();
export type WeeklyRouteSuggestion = z.infer<typeof weeklyRouteSuggestionSchema>;

export const weeklyRouteProposalSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal('rules'), weekStart: z.iso.date(),
  sellerId: z.uuid(), generatedAt: z.iso.datetime({ offset: true }),
  policy: weeklyRoutePolicySchema, origin: weeklyRouteBaseCityOriginSchema,
  sources: z.object({
    sales: z.object({ status: z.enum(['available', 'unavailable']), generationId: z.uuid().nullable(),
      asOfDate: z.iso.date().nullable() }).strict(),
    scrap: z.object({ status: z.enum(['available', 'unavailable']), generationId: z.uuid().nullable(),
      publishedAt: z.iso.datetime({ offset: true }).nullable() }).strict(),
    visits: z.object({ status: z.enum(['available', 'unavailable']),
      asOfDate: z.iso.date().nullable() }).strict().default({ status: 'unavailable', asOfDate: null }),
  }).strict(),
  strategy: z.object({
    kind: z.enum(['local', 'trip', 'pending']),
    region: z.string().trim().min(1).max(160).nullable(),
    distanceFromBaseKm: z.number().finite().nonnegative().nullable(),
  }).strict().default({ kind: 'pending', region: null, distanceFromBaseKm: null }),
  days: z.array(z.object({ dayIndex: z.number().int().min(0).max(4), serviceDate: z.iso.date(),
    suggestions: z.array(weeklyRouteSuggestionSchema).max(10) }).strict()).length(5),
  excluded: z.array(z.object({ clientId: z.uuid(), name: z.string().trim().min(1).max(160).optional(),
    reason: weeklyRouteExclusionReasonSchema }).strict()),
  counts: z.object({ evaluated: z.number().int().nonnegative(), suggested: z.number().int().nonnegative(),
    inactiveLost: z.number().int().nonnegative(), noPurchaseHistory: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    coverageDue: z.number().int().nonnegative().default(0),
    coveragePlanned: z.number().int().nonnegative().default(0),
    coveragePending: z.number().int().nonnegative().default(0),
  }).strict(),
}).strict();
export type WeeklyRouteProposal = z.infer<typeof weeklyRouteProposalSchema>;

export const weeklyRouteProposalStatusSchema = z.enum([
  'draft', 'published', 'rejected', 'superseded',
]);

export const persistedWeeklyRouteProposalSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: z.uuid(),
  version: z.number().int().positive(),
  status: weeklyRouteProposalStatusSchema,
  proposal: weeklyRouteProposalSchema,
  createdBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  publishedBy: z.uuid().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  routeIds: z.array(z.uuid()).max(5),
  predecessorId: z.uuid().nullable().optional(),
  predecessorVersion: z.number().int().positive().nullable().optional(),
}).strict();
export type PersistedWeeklyRouteProposal = z.infer<typeof persistedWeeklyRouteProposalSchema>;

export const saveWeeklyRouteProposalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  strategyPreference: weeklyRouteStrategyPreferenceSchema.default('auto'),
  proposal: weeklyRouteProposalSchema,
}).strict();
export type SaveWeeklyRouteProposalRequest = z.infer<typeof saveWeeklyRouteProposalRequestSchema>;

export const regenerateWeeklyRouteProposalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  expectedVersion: z.number().int().positive(),
  strategyPreference: weeklyRouteStrategyPreferenceSchema.default('auto'),
  proposal: weeklyRouteProposalSchema,
}).strict();
export type RegenerateWeeklyRouteProposalRequest = z.infer<typeof regenerateWeeklyRouteProposalRequestSchema>;

export const weeklyRouteProposalMutationRequestSchema = z.object({
  schemaVersion: z.literal(1),
  weekStart: z.iso.date(),
  sellerId: z.uuid(),
  idempotencyKey: z.uuid(),
  operation: z.enum(['open_or_generate', 'regenerate']).default('open_or_generate'),
  strategyPreference: weeklyRouteStrategyPreferenceSchema.optional(),
  proposalId: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.operation === 'regenerate' && (!value.proposalId || !value.expectedVersion)) {
    context.addIssue({ code: 'custom', path: ['proposalId'],
      message: 'Informe a proposta e a versão esperada para regenerar.' });
  }
});
export type WeeklyRouteProposalMutationRequest = z.infer<typeof weeklyRouteProposalMutationRequestSchema>;

export const weeklyRouteProposalMutationResponseSchema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(['created', 'existing', 'regenerated']),
  record: persistedWeeklyRouteProposalSchema,
}).strict();
export type WeeklyRouteProposalMutationResponse = z.infer<typeof weeklyRouteProposalMutationResponseSchema>;

export const weeklyRouteVisitCoverageResponseSchema = z.object({
  schemaVersion: z.literal(1),
  sellerId: z.uuid(),
  source: z.literal('api.visits'),
  observedAt: z.iso.datetime({ offset: true }),
  clients: z.array(z.object({
    clientId: z.uuid(),
    lastCompletedVisitAt: z.iso.datetime({ offset: true }).nullable(),
    visitId: z.uuid().nullable(),
  }).strict()).max(5000),
}).strict();
export type WeeklyRouteVisitCoverageResponse = z.infer<typeof weeklyRouteVisitCoverageResponseSchema>;

export const reviseWeeklyRouteProposalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  expectedVersion: z.number().int().positive(),
  days: weeklyRouteProposalSchema.shape.days,
}).strict();
export type ReviseWeeklyRouteProposalRequest = z.infer<typeof reviseWeeklyRouteProposalRequestSchema>;

export const decideWeeklyRouteProposalRequestSchema = z.object({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['publish', 'reject']),
  reason: z.string().trim().min(1).max(500).nullable(),
}).strict().superRefine((value, context) => {
  if (value.decision === 'reject' && value.reason === null) {
    context.addIssue({ code: 'custom', path: ['reason'], message: 'Informe o motivo da rejeição.' });
  }
});
export type DecideWeeklyRouteProposalRequest = z.infer<typeof decideWeeklyRouteProposalRequestSchema>;

export const dailySellerLocationCaptureSchema = coordinateSchema.extend({
  schemaVersion: z.literal(1),
  idempotencyKey: z.uuid(),
  capturedAt: z.iso.datetime({ offset: true }),
  accuracyM: z.number().finite().nonnegative().max(10_000),
}).strict();
export type DailySellerLocationCapture = z.infer<typeof dailySellerLocationCaptureSchema>;

export const dailySellerLocationSchema = currentGpsRouteOriginSchema.extend({
  locationId: z.uuid(),
  capturedBy: z.uuid(),
  version: z.number().int().positive(),
}).strict();
export type DailySellerLocation = z.infer<typeof dailySellerLocationSchema>;
