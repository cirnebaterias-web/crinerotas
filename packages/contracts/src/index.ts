import { z } from 'zod';
export * from './scrap-revisions';
export * from './client-reference';
export * from './clients';
export * from './client-imports';

export const liveResponseSchema = z.object({ status: z.literal('ok') }).strict();
export type LiveResponse = z.infer<typeof liveResponseSchema>;
export const livePath = '/api/v1/health/live';

export const roleCodeSchema = z.enum(['seller', 'manager', 'administrator', 'logistics']);
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
  'IDEMPOTENCY_KEY_REUSED',
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
export const visitCompetitorPricesPath = (offlineId: string) =>
  `${visitsPath}/${offlineId}/sections/competitor-prices`;
export const commercialActionsPath = '/api/v1/commercial-actions';
export const commercialActionPath = (actionId: string) => `${commercialActionsPath}/${actionId}`;
export const visitCommercialActionsPath = (offlineId: string) =>
  `${visitsPath}/${offlineId}/sections/commercial-actions`;
export const scrapPath = '/api/v1/scrap';
export const scrapClientsPath = `${scrapPath}/clients`;
export const scrapPointsPath = `${scrapPath}/points`;
export const scrapPointPath = (pointId: string) => `${scrapPointsPath}/${pointId}`;
export const scrapSchedulesPath = `${scrapPath}/schedules`;
export const scrapSchedulePath = (scheduleId: string) => `${scrapSchedulesPath}/${scheduleId}`;
export const scrapCollectionsPath = `${scrapPath}/collections`;
export const scrapCollectionReceiptPath = (collectionId: string) => `${scrapCollectionsPath}/${collectionId}/receipt`;
export const scrapCollectionAttachmentsPath = (collectionId: string) => `${scrapCollectionsPath}/${collectionId}/attachments`;
export const scrapAttachmentUploadIntentsPath = `${scrapPath}/attachments/upload-intents`;
export const scrapAttachmentConfirmPath = (offlineId: string) => `${scrapPath}/attachments/${offlineId}/confirm`;
export const attachmentUploadIntentsPath = '/api/v1/attachments/upload-intents';
export const attachmentConfirmPath = (offlineId: string) =>
  `/api/v1/attachments/${offlineId}/confirm`;
export const visitCompletePath = (offlineId: string) => `${visitsPath}/${offlineId}/complete`;
export const visitCheckinEvidencePath = (offlineId: string) =>
  `${visitsPath}/${offlineId}/evidence/checkin`;
export const currentParameterSetPath = '/api/v1/parameter-sets/current';
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

export const evidencePurposeSchema = z.enum([
  'visit_checkin', 'visit_checkout', 'commercial_action_evidence',
]);
export const evidenceIssueSchema = z.enum([
  'camera_unavailable',
  'gps_unavailable',
  'gps_low_accuracy',
  'outside_radius',
  'client_location_missing',
]);
export const evidenceLocationSchema = z.object({
  latitude: canonicalDecimalSchema.refine((value) => Math.abs(Number(value)) <= 90).optional(),
  longitude: canonicalDecimalSchema.refine((value) => Math.abs(Number(value)) <= 180).optional(),
  accuracyM: nonNegativeDecimalSchema.optional(),
  distanceM: nonNegativeDecimalSchema.optional(),
}).strict().refine((value) => Boolean(value.latitude) === Boolean(value.longitude), {
  message: 'Latitude e longitude devem ser informadas juntas.',
});
export const attachmentUploadIntentRequestSchema = z.object({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  visitOfflineId: z.uuid(),
  purpose: evidencePurposeSchema,
  contentType: z.enum(['image/jpeg', 'image/webp']),
  byteSize: z.number().int().positive().max(2 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  capturedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();
export type AttachmentUploadIntentRequest = z.infer<typeof attachmentUploadIntentRequestSchema>;
export const attachmentUploadIntentResultSchema = z.object({
  schemaVersion: z.literal(1),
  attachmentId: z.uuid(),
  offlineId: z.uuid(),
  storagePath: z.string().regex(/^[a-z0-9/_-]+\.(?:jpe?g|webp)$/u).max(500),
  signedUrl: z.string().url(),
  token: z.string().min(1).max(4096),
  expiresInSeconds: z.literal(600),
  alreadyVerified: z.boolean(),
  verifiedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type AttachmentUploadIntentResult = z.infer<typeof attachmentUploadIntentResultSchema>;
const scrapAttachmentIntentBaseSchema = z.object({
  schemaVersion: z.literal(1),
  attachmentId: z.uuid(),
  offlineId: z.uuid(),
});
export const scrapAttachmentUploadIntentResultSchema = z.discriminatedUnion('alreadyVerified', [
  scrapAttachmentIntentBaseSchema.extend({
    alreadyVerified: z.literal(true),
    verifiedAt: z.iso.datetime({ offset: true }),
  }).strict(),
  scrapAttachmentIntentBaseSchema.extend({
    alreadyVerified: z.literal(false),
    signedUrl: z.string().url(),
    token: z.string().min(1).max(4096),
    expiresInSeconds: z.literal(600),
  }).strict(),
]);
export type ScrapAttachmentUploadIntentResult = z.infer<typeof scrapAttachmentUploadIntentResultSchema>;
export const attachmentConfirmRequestSchema = z.object({
  schemaVersion: z.literal(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type AttachmentConfirmRequest = z.infer<typeof attachmentConfirmRequestSchema>;
export const attachmentConfirmationSchema = z.object({
  schemaVersion: z.literal(1),
  attachmentId: z.uuid(),
  offlineId: z.uuid(),
  status: z.literal('verified'),
  verifiedAt: z.iso.datetime({ offset: true }),
}).strict();
export type AttachmentConfirmation = z.infer<typeof attachmentConfirmationSchema>;
const visitEvidenceCommandSchema = z.object({
  offlineId: z.uuid(),
  attachmentOfflineId: z.uuid().optional(),
  capturedAt: z.iso.datetime({ offset: true }),
  location: evidenceLocationSchema,
  issues: z.array(evidenceIssueSchema).max(5),
  justification: z.string().trim().min(10).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.issues.length > 0 && !value.justification) {
    context.addIssue({ code: 'custom', path: ['justification'], message: 'Justifique a exceção.' });
  }
  if (!value.attachmentOfflineId && !value.issues.includes('camera_unavailable')) {
    context.addIssue({ code: 'custom', path: ['attachmentOfflineId'], message: 'A fotografia é obrigatória.' });
  }
});
export const completeVisitRequestSchema = z.object({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  deviceCompletedAt: z.iso.datetime({ offset: true }),
  evidence: visitEvidenceCommandSchema,
}).strict();
export type CompleteVisitRequest = z.infer<typeof completeVisitRequestSchema>;
export const saveVisitCheckinEvidenceRequestSchema = z.object({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  evidence: visitEvidenceCommandSchema,
}).strict();
export type SaveVisitCheckinEvidenceRequest = z.infer<typeof saveVisitCheckinEvidenceRequestSchema>;
export const visitEvidenceResultSchema = z.object({
  schemaVersion: z.literal(1),
  visitId: z.uuid(),
  offlineId: z.uuid(),
  kind: z.literal('checkin'),
  serverSavedAt: z.iso.datetime({ offset: true }),
}).strict();
export type VisitEvidenceResult = z.infer<typeof visitEvidenceResultSchema>;
export const visitCompletionResultSchema = z.object({
  schemaVersion: z.literal(1),
  visitId: z.uuid(),
  offlineId: z.uuid(),
  status: z.literal('completed'),
  deviceCompletedAt: z.iso.datetime({ offset: true }),
  serverCompletedAt: z.iso.datetime({ offset: true }),
}).strict();
export type VisitCompletionResult = z.infer<typeof visitCompletionResultSchema>;

const stockObservationSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() || undefined : value,
  z.string().max(500).optional(),
);

export const ownStockBrandSchema = z.enum(['Heliar', 'América', 'Durex', 'ACDelco']);
export const ownStockLineSchema = z.object({
  brand: ownStockBrandSchema,
  model: z.string().trim().min(1).max(120),
  quantity: z.number().int().nonnegative(),
  productCode: z.string().trim().min(1).max(60).optional(),
  sku: z.string().trim().min(1).max(80).optional(),
  unitWeightKg: nonNegativeDecimalSchema.refine((value) => Number(value) > 0).optional(),
  catalogVersion: z.number().int().positive().optional(),
  weightSource: z.enum(['catalog', 'fallback_15kg']).optional(),
}).strict();
export type OwnStockLine = z.infer<typeof ownStockLineSchema>;

export const competitorStockBrandSchema = z.enum(['Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro', 'Outra']);
export const competitorStockLineSchema = z.object({
  brand: competitorStockBrandSchema,
  amperage: z.number().int().positive().max(999),
  technology: z.string().trim().min(1).max(60),
  quantity: z.number().int().nonnegative(),
  otherBrand: z.string().trim().min(1).max(80).optional(),
}).strict().refine((line) => line.brand !== 'Outra' || Boolean(line.otherBrand), {
  message: 'Informe o nome da marca.', path: ['otherBrand'],
});
export type CompetitorStockLine = z.infer<typeof competitorStockLineSchema>;

export const stockInputSchema = z.object({
  heliarQuantity: z.number().int().nonnegative(),
  mouraQuantity: z.number().int().nonnegative(),
  ownLines: z.array(ownStockLineSchema).max(200).optional(),
  completedOwnBrands: z.array(ownStockBrandSchema).max(4)
    .refine((brands) => new Set(brands).size === brands.length,
      'Cada marca deve aparecer apenas uma vez.').optional(),
  competitorLines: z.array(competitorStockLineSchema).max(200).optional(),
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

const priceObservationSchema = z.preprocess(
  (value) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() || undefined : value,
  z.string().max(500).optional(),
);
const positiveMoneyBrlSchema = z.string()
  .regex(/^\d+(?:\.\d+)?$/, 'Informe o preço como decimal positivo.')
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, 'O preço deve ser maior que zero.');

export const competitorPriceQuotationSchema = z.object({
  competitorId: z.uuid(),
  productCode: z.string().trim().min(1).max(60).optional(),
  modelOrAmperage: z.string().trim().min(1).max(120),
  technologyId: z.uuid(),
  priceBrl: positiveMoneyBrlSchema,
  conditionId: z.uuid(),
  observation: priceObservationSchema,
}).strict();
export type CompetitorPriceQuotation = z.infer<typeof competitorPriceQuotationSchema>;

const availableCompetitorPricesSchema = z.object({
  availability: z.literal('available'),
  quotations: z.array(competitorPriceQuotationSchema).min(1).max(25),
}).strict();
const unavailableCompetitorPricesSchema = z.object({
  availability: z.literal('unavailable'),
  unavailableReasonId: z.uuid(),
}).strict();
export const competitorPricesInputSchema = z.discriminatedUnion('availability', [
  availableCompetitorPricesSchema,
  unavailableCompetitorPricesSchema,
]);
export type CompetitorPricesInput = z.infer<typeof competitorPricesInputSchema>;

const competitorPricesRequestFields = {
    schemaVersion: z.literal(1),
    offlineId: z.uuid(),
    deviceSavedAt: z.iso.datetime({ offset: true }),
};
export const saveCompetitorPricesRequestSchema = z.discriminatedUnion('availability', [
  availableCompetitorPricesSchema.extend(competitorPricesRequestFields).strict(),
  unavailableCompetitorPricesSchema.extend(competitorPricesRequestFields).strict(),
]);
export type SaveCompetitorPricesRequest = z.infer<typeof saveCompetitorPricesRequestSchema>;

export const competitorPricesResultSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: z.uuid(),
  visitId: z.uuid(),
  offlineId: z.uuid(),
  availability: z.enum(['available', 'unavailable']),
  quotationIds: z.array(z.uuid()).max(25),
  unavailableReasonId: z.uuid().nullable(),
  serverSavedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((result, context) => {
  if (result.availability === 'available' && (result.quotationIds.length === 0 || result.unavailableReasonId)) {
    context.addIssue({ code: 'custom', path: ['availability'], message: 'Resposta disponível exige cotações e não aceita motivo.' });
  }
  if (result.availability === 'unavailable' && (result.quotationIds.length > 0 || !result.unavailableReasonId)) {
    context.addIssue({ code: 'custom', path: ['availability'], message: 'Resposta indisponível exige motivo e não aceita cotações.' });
  }
});
export type CompetitorPricesResult = z.infer<typeof competitorPricesResultSchema>;

export const competitorCommercialActionTypeSchema = z.enum([
  'differentiated_price',
  'seller_or_driver_incentive',
  'retailer_incentive',
  'purchase_combo',
  'other',
]);
export type CompetitorCommercialActionType = z.infer<typeof competitorCommercialActionTypeSchema>;

export const commercialActionSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  validFrom: z.iso.date(),
  validUntil: z.iso.date(),
  bannerUrl: z.string().url().max(1000).optional(),
  active: z.boolean(),
}).strict().refine((action) => action.validUntil >= action.validFrom, {
  message: 'O término da ação deve ser igual ou posterior ao início.', path: ['validUntil'],
});
export type CommercialAction = z.infer<typeof commercialActionSchema>;

export const commercialActionListSchema = z.object({
  schemaVersion: z.literal(1),
  actions: z.array(commercialActionSchema).max(100),
}).strict();
export type CommercialActionList = z.infer<typeof commercialActionListSchema>;

export const saveCommercialActionRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  validFrom: z.iso.date(),
  validUntil: z.iso.date(),
  bannerUrl: z.string().url().max(1000).optional(),
  active: z.boolean(),
}).strict().refine((action) => action.validUntil >= action.validFrom, {
  message: 'O término da ação deve ser igual ou posterior ao início.', path: ['validUntil'],
});
export type SaveCommercialActionRequest = z.infer<typeof saveCommercialActionRequestSchema>;

export const ownCommercialActionAcknowledgementSchema = z.object({
  actionId: z.uuid(),
  title: z.string().trim().min(1).max(120),
  validFrom: z.iso.date(),
  validUntil: z.iso.date(),
  presented: z.literal(true),
}).strict();

export const competitorCommercialActionSchema = z.object({
  offlineId: z.uuid(),
  competitorId: z.uuid(),
  actionType: competitorCommercialActionTypeSchema,
  otherType: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(1200),
  validFrom: z.iso.date(),
  validUntil: z.iso.date(),
  evidenceAttachmentOfflineId: z.uuid().optional(),
}).strict().superRefine((action, context) => {
  if (action.validUntil < action.validFrom) {
    context.addIssue({ code: 'custom', path: ['validUntil'], message: 'O término deve ser igual ou posterior ao início.' });
  }
  if (action.actionType === 'other' && !action.otherType) {
    context.addIssue({ code: 'custom', path: ['otherType'], message: 'Descreva o outro tipo de ação.' });
  }
  if (action.actionType !== 'other' && action.otherType) {
    context.addIssue({ code: 'custom', path: ['otherType'], message: 'Outro tipo só é aceito na classificação Outros.' });
  }
});

export const competitorCommercialActionsInputSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('not_identified') }).strict(),
  z.object({
    availability: z.literal('identified'),
    actions: z.array(competitorCommercialActionSchema).min(1).max(10),
  }).strict(),
]);

export const commercialActionsInputSchema = z.object({
  ownAcknowledgements: z.array(ownCommercialActionAcknowledgementSchema).max(50),
  competitor: competitorCommercialActionsInputSchema,
}).strict();
export type CommercialActionsInput = z.infer<typeof commercialActionsInputSchema>;

export const saveVisitCommercialActionsRequestSchema = commercialActionsInputSchema.extend({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  deviceSavedAt: z.iso.datetime({ offset: true }),
}).strict();
export type SaveVisitCommercialActionsRequest = z.infer<typeof saveVisitCommercialActionsRequestSchema>;

// Scrap collection is a realized handoff; scheduling is a future request and never realized weight.
const positiveScrapWeightSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
  .max(32).refine((value) => Number(value) > 0 && Number.isFinite(Number(value)), 'Informe kg maior que zero.');
export const scrapPeriodSchema = z.enum(['morning', 'afternoon']);
export const scrapDestinationTypeSchema = z.enum(['concentration_point', 'headquarters']);
export const scrapCollectionInputSchema = z.object({
  offlineId: z.uuid(),
  actualWeightKg: positiveScrapWeightSchema,
  collectedAt: z.iso.datetime({ offset: true }),
  receiptNumber: z.string().trim().min(1).max(80),
  clientSigned: z.literal(true),
  sellerSigned: z.literal(true),
  twoCopies: z.literal(true),
  destinationType: scrapDestinationTypeSchema,
  concentrationPointId: z.uuid().optional(),
  attachmentOfflineIds: z.array(z.uuid()).min(1).max(4),
}).strict().superRefine((value, context) => {
  if (value.destinationType === 'concentration_point' && !value.concentrationPointId) {
    context.addIssue({ code: 'custom', path: ['concentrationPointId'], message: 'Selecione o ponto de concentração.' });
  }
  if (value.destinationType === 'headquarters' && value.concentrationPointId) {
    context.addIssue({ code: 'custom', path: ['concentrationPointId'], message: 'A matriz não usa ponto de concentração.' });
  }
  if (new Set(value.attachmentOfflineIds).size !== value.attachmentOfflineIds.length) {
    context.addIssue({ code: 'custom', path: ['attachmentOfflineIds'], message: 'Fotografia repetida no termo.' });
  }
});
export type ScrapCollectionInput = z.infer<typeof scrapCollectionInputSchema>;

export const pickupScheduleInputSchema = z.object({
  offlineId: z.uuid(),
  estimatedWeightKg: positiveScrapWeightSchema,
  desiredDate: z.iso.date(),
  period: scrapPeriodSchema,
  observation: z.string().trim().max(1000).optional(),
  requestedAt: z.iso.datetime({ offset: true }),
}).strict();
export type PickupScheduleInput = z.infer<typeof pickupScheduleInputSchema>;

export const visitScrapInputSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('none') }).strict(),
  z.object({ availability: z.literal('collected'), collection: scrapCollectionInputSchema }).strict(),
  z.object({ availability: z.literal('scheduled'), schedule: pickupScheduleInputSchema }).strict(),
]);
export type VisitScrapInput = z.infer<typeof visitScrapInputSchema>;
export const visitScrapSavedPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  offlineId: z.uuid(),
  deviceSavedAt: z.iso.datetime({ offset: true }),
  availability: z.enum(['none', 'collected', 'scheduled']),
  collection: scrapCollectionInputSchema.optional(),
  schedule: pickupScheduleInputSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.availability === 'collected') !== Boolean(value.collection) ||
      (value.availability === 'scheduled') !== Boolean(value.schedule)) {
    context.addIssue({ code: 'custom', path: ['availability'], message: 'Informe somente os dados do tipo selecionado.' });
  }
});
export type VisitScrapSavedPayload = z.infer<typeof visitScrapSavedPayloadSchema>;

export const scrapClientSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(160), address: z.string().trim().min(1).max(300),
}).strict();
export const scrapClientListSchema = z.object({
  schemaVersion: z.literal(1), clients: z.array(scrapClientSchema).max(30),
}).strict();
export type ScrapClient = z.infer<typeof scrapClientSchema>;

export const scrapPointSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300), active: z.boolean(), version: z.number().int().positive(),
}).strict();
export const scrapPointListSchema = z.object({
  schemaVersion: z.literal(1), points: z.array(scrapPointSchema).max(500),
}).strict();
export type ScrapPoint = z.infer<typeof scrapPointSchema>;
export const saveScrapPointRequestSchema = z.object({
  schemaVersion: z.literal(1), id: z.uuid().optional(),
  name: z.string().trim().min(1).max(160), address: z.string().trim().min(1).max(300),
  active: z.boolean(), expectedVersion: z.number().int().positive().optional(),
}).strict();
export type SaveScrapPointRequest = z.infer<typeof saveScrapPointRequestSchema>;

export const createPickupScheduleRequestSchema = pickupScheduleInputSchema.extend({
  schemaVersion: z.literal(1), clientId: z.uuid(), visitOfflineId: z.uuid().optional(),
}).strict();
export type CreatePickupScheduleRequest = z.infer<typeof createPickupScheduleRequestSchema>;
export const revisePickupScheduleRequestSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion: z.number().int().positive(),
  estimatedWeightKg: positiveScrapWeightSchema, desiredDate: z.iso.date(), period: scrapPeriodSchema,
  observation: z.string().trim().max(1000).optional(), reason: z.string().trim().min(1).max(500),
}).strict();
export type RevisePickupScheduleRequest = z.infer<typeof revisePickupScheduleRequestSchema>;

export const scrapActorSchema = z.object({ id: z.uuid(), displayName: z.string().trim().min(1).max(120) }).strict();
export const pickupScheduleSchema = z.object({
  id: z.uuid(), offlineId: z.uuid(), client: scrapClientSchema, seller: scrapActorSchema,
  origin: z.enum(['visit', 'standalone']), visitId: z.uuid().nullable(),
  estimatedWeightKg: positiveScrapWeightSchema, desiredDate: z.iso.date(), period: scrapPeriodSchema,
  observation: z.string().nullable(), requestedAt: z.iso.datetime({ offset: true }),
  serverSavedAt: z.iso.datetime({ offset: true }), status: z.literal('pending'),
  version: z.number().int().positive(),
}).strict();
export type PickupSchedule = z.infer<typeof pickupScheduleSchema>;

export const confirmScrapReceiptRequestSchema = z.object({
  schemaVersion: z.literal(1), expectedVersion: z.number().int().positive(),
  receivedWeightKg: positiveScrapWeightSchema,
  receivedLocation: z.string().trim().min(1).max(300),
  observation: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type ConfirmScrapReceiptRequest = z.infer<typeof confirmScrapReceiptRequestSchema>;
export const scrapReceiptSchema = z.object({
  collectionId: z.uuid(), receivedWeightKg: positiveScrapWeightSchema,
  receivedLocation: z.string().trim().min(1).max(300), observation: z.string().nullable(),
  receivedBy: scrapActorSchema, receivedAt: z.iso.datetime({ offset: true }),
  version: z.number().int().positive(),
}).strict();
export type ScrapReceipt = z.infer<typeof scrapReceiptSchema>;
export const scrapCollectionSchema = z.object({
  id: z.uuid(), offlineId: z.uuid(), client: scrapClientSchema, seller: scrapActorSchema,
  actualWeightKg: positiveScrapWeightSchema, receiptNumber: z.string().trim().min(1).max(80),
  collectedAt: z.iso.datetime({ offset: true }), serverSavedAt: z.iso.datetime({ offset: true }),
  destinationType: scrapDestinationTypeSchema,
  concentrationPoint: scrapClientSchema.nullable(),
  status: z.enum(['awaiting_receipt', 'received']), version: z.number().int().positive(),
  attachmentOfflineIds: z.array(z.uuid()).min(1).max(4),
  attachments: z.array(z.object({ offlineId: z.uuid(), status: z.enum(['reserved', 'verified']) }).strict()).max(4),
  receipt: scrapReceiptSchema.nullable(), retentionUntil: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type ScrapCollection = z.infer<typeof scrapCollectionSchema>;
export const scrapOperationsSchema = z.object({
  schemaVersion: z.literal(1), collections: z.array(scrapCollectionSchema),
  schedules: z.array(pickupScheduleSchema),
  totals: z.object({ collectedKg: nonNegativeDecimalSchema, receivedKg: nonNegativeDecimalSchema,
    scheduledKg: nonNegativeDecimalSchema }).strict(),
}).strict();
export type ScrapOperations = z.infer<typeof scrapOperationsSchema>;

export const scrapAttachmentUploadIntentRequestSchema = z.object({
  schemaVersion: z.literal(1), offlineId: z.uuid(), collectionOfflineId: z.uuid(),
  contentType: z.enum(['image/jpeg', 'image/webp']), byteSize: z.number().int().positive().max(2 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u), capturedAt: z.iso.datetime({ offset: true }),
}).strict();
export type ScrapAttachmentUploadIntentRequest = z.infer<typeof scrapAttachmentUploadIntentRequestSchema>;

export const parameterValueCategorySchema = z.enum([
  'competitor',
  'competitor_price_technology',
  'competitor_price_condition',
  'competitor_price_unavailable_reason',
]);
export const parameterValueSchema = z.object({
  id: z.uuid(),
  category: parameterValueCategorySchema,
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().nonnegative(),
}).strict();
export const competitorPriceParameterSetSchema = z.object({
  schemaVersion: z.literal(1),
  parameterSetId: z.uuid(),
  version: z.number().int().positive(),
  validFrom: z.iso.datetime({ offset: true }),
  values: z.object({
    competitors: z.array(parameterValueSchema.extend({ category: z.literal('competitor') })).max(100),
    technologies: z.array(parameterValueSchema.extend({ category: z.literal('competitor_price_technology') })).max(100),
    conditions: z.array(parameterValueSchema.extend({ category: z.literal('competitor_price_condition') })).max(100),
    unavailableReasons: z.array(parameterValueSchema.extend({ category: z.literal('competitor_price_unavailable_reason') })).max(100),
  }).strict(),
}).strict();
export type CompetitorPriceParameterSet = z.infer<typeof competitorPriceParameterSetSchema>;
export const localCompetitorPriceParameterSetSchema = competitorPriceParameterSetSchema.extend({
  userId: z.uuid(),
  deviceId: z.uuid(),
  cachedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalCompetitorPriceParameterSet = z.infer<typeof localCompetitorPriceParameterSetSchema>;

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

const visitPricesSavedPayloadFields = {
    offlineId: z.uuid(),
    deviceSavedAt: z.iso.datetime({ offset: true }),
};
export const visitPricesSavedPayloadSchema = z.discriminatedUnion('availability', [
  availableCompetitorPricesSchema.extend(visitPricesSavedPayloadFields).strict(),
  unavailableCompetitorPricesSchema.extend(visitPricesSavedPayloadFields).strict(),
]);
export type VisitPricesSavedPayload = z.infer<typeof visitPricesSavedPayloadSchema>;

export const visitCommercialActionsSavedPayloadSchema = commercialActionsInputSchema.extend({
  offlineId: z.uuid(),
  deviceSavedAt: z.iso.datetime({ offset: true }),
}).strict();
export type VisitCommercialActionsSavedPayload = z.infer<typeof visitCommercialActionsSavedPayloadSchema>;

export const syncOperationSchema = z.enum([
  'visit.draft.saved',
  'visit.started.v1',
  'visit.stock.saved.v1',
  'visit.prices.saved.v1',
  'visit.commercial-actions.saved.v1',
  'visit.scrap.saved.v1',
]);
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

const visitPricesSavedSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.prices.saved.v1'),
  aggregateType: z.literal('visit'),
  payload: visitPricesSavedPayloadSchema,
}).strict().superRefine((command, context) => {
  if (command.sequence < 3) {
    context.addIssue({ code: 'custom', path: ['sequence'], message: 'Preços exigem início e estoque anteriores.' });
  }
  if (command.aggregateId !== command.payload.offlineId) {
    context.addIssue({ code: 'custom', path: ['payload', 'offlineId'], message: 'O agregado deve corresponder ao offlineId da visita.' });
  }
  if (command.occurredAt !== command.payload.deviceSavedAt) {
    context.addIssue({ code: 'custom', path: ['occurredAt'], message: 'O horário do evento deve corresponder ao salvamento no aparelho.' });
  }
});

const visitCommercialActionsSavedSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.commercial-actions.saved.v1'),
  aggregateType: z.literal('visit'),
  payload: visitCommercialActionsSavedPayloadSchema,
}).strict().superRefine((command, context) => {
  if (command.sequence < 4) {
    context.addIssue({ code: 'custom', path: ['sequence'], message: 'Ações comerciais exigem as etapas anteriores.' });
  }
  if (command.aggregateId !== command.payload.offlineId) {
    context.addIssue({ code: 'custom', path: ['payload', 'offlineId'], message: 'O agregado deve corresponder ao offlineId da visita.' });
  }
  if (command.occurredAt !== command.payload.deviceSavedAt) {
    context.addIssue({ code: 'custom', path: ['occurredAt'], message: 'O horário deve corresponder ao salvamento no aparelho.' });
  }
});

const visitScrapSavedSyncCommandSchema = syncCommandBaseSchema.extend({
  operation: z.literal('visit.scrap.saved.v1'),
  aggregateType: z.literal('visit'),
  payload: visitScrapSavedPayloadSchema,
}).strict().superRefine((command, context) => {
  if (command.sequence < 5) {
    context.addIssue({ code: 'custom', path: ['sequence'], message: 'A sucata exige as etapas anteriores.' });
  }
  if (command.aggregateId !== command.payload.offlineId) {
    context.addIssue({ code: 'custom', path: ['payload', 'offlineId'], message: 'O agregado deve corresponder à visita.' });
  }
  if (command.occurredAt !== command.payload.deviceSavedAt) {
    context.addIssue({ code: 'custom', path: ['occurredAt'], message: 'O horário deve corresponder ao salvamento.' });
  }
});

export const syncCommandSchema = z.discriminatedUnion('operation', [
  legacyDraftSyncCommandSchema,
  visitStartedSyncCommandSchema,
  visitStockSavedSyncCommandSchema,
  visitPricesSavedSyncCommandSchema,
  visitCommercialActionsSavedSyncCommandSchema,
  visitScrapSavedSyncCommandSchema,
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
  parameterSetId: z.uuid().optional(),
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
  currentStep: z.enum(['start', 'stock', 'competitor-stock', 'prices', 'actions', 'scrap', 'review', 'complete']),
  acknowledged: z.boolean().optional(),
  deviceStartedAt: z.iso.datetime({ offset: true }).optional(),
  client: routeClientSnapshotSchema.optional(),
  canonicalVisitId: z.uuid().optional(),
  parameterSetId: z.uuid().optional(),
  serverStartedAt: z.iso.datetime({ offset: true }).optional(),
  lastConfirmedSequence: z.number().int().positive().optional(),
  stock: stockInputSchema.extend({
    eventId: z.uuid(),
    deviceSavedAt: z.iso.datetime({ offset: true }),
    serverSavedAt: z.iso.datetime({ offset: true }).optional(),
    persistenceState: z.enum(['saved_on_device', 'synced']),
  }).strict().optional(),
  prices: z.discriminatedUnion('availability', [
    availableCompetitorPricesSchema.extend({
      eventId: z.uuid(),
      deviceSavedAt: z.iso.datetime({ offset: true }),
      serverSavedAt: z.iso.datetime({ offset: true }).optional(),
      persistenceState: z.enum(['saved_on_device', 'synced']),
    }).strict(),
    unavailableCompetitorPricesSchema.extend({
      eventId: z.uuid(),
      deviceSavedAt: z.iso.datetime({ offset: true }),
      serverSavedAt: z.iso.datetime({ offset: true }).optional(),
      persistenceState: z.enum(['saved_on_device', 'synced']),
    }).strict(),
  ]).optional(),
  commercialActions: commercialActionsInputSchema.extend({
    eventId: z.uuid(),
    deviceSavedAt: z.iso.datetime({ offset: true }),
    serverSavedAt: z.iso.datetime({ offset: true }).optional(),
    persistenceState: z.enum(['saved_on_device', 'synced']),
  }).strict().optional(),
  scrap: z.object({
    deviceSavedAt: z.iso.datetime({ offset: true }),
    availability: z.enum(['none', 'collected', 'scheduled']),
    collection: scrapCollectionInputSchema.optional(),
    schedule: pickupScheduleInputSchema.optional(),
    eventId: z.uuid(),
    serverSavedAt: z.iso.datetime({ offset: true }).optional(),
    persistenceState: z.enum(['saved_on_device', 'synced']),
  }).strict().superRefine((value, context) => {
    if ((value.availability === 'collected') !== Boolean(value.collection) ||
        (value.availability === 'scheduled') !== Boolean(value.schedule)) {
      context.addIssue({ code: 'custom', path: ['availability'], message: 'Informe somente os dados do tipo selecionado.' });
    }
  }).optional(),
  localStatus: z.enum(['draft', 'completed']),
  deviceCompletedAt: z.iso.datetime({ offset: true }).optional(),
  persistenceState: z.enum(['saved_on_device', 'synced']),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();
export type LocalVisitDraft = z.infer<typeof localVisitDraftSchema>;

export const localAttachmentMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  userId: z.uuid(),
  deviceId: z.uuid(),
  offlineId: z.uuid(),
  visitOfflineId: z.uuid(),
  purpose: z.enum(['stock_evidence', 'commercial_action_evidence', 'scrap_receipt', 'visit_checkin', 'visit_checkout']),
  targetOfflineId: z.uuid().optional(),
  fileName: z.string().trim().min(1).max(160),
  contentType: z.enum(['image/jpeg', 'image/webp']),
  byteSize: z.number().int().positive().max(2 * 1024 * 1024),
  width: z.number().int().positive().max(1600),
  height: z.number().int().positive().max(1600),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  capturedAt: z.iso.datetime({ offset: true }),
  status: z.enum(['pending', 'verified', 'synced', 'action_required']),
  remoteAttachmentId: z.uuid().optional(),
  serverVerifiedAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type LocalAttachmentMetadata = z.infer<typeof localAttachmentMetadataSchema>;
export type LocalAttachment = LocalAttachmentMetadata & { blob: Blob };

export const visitEvidenceIssueSchema = evidenceIssueSchema;
export const localVisitEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  userId: z.uuid(),
  deviceId: z.uuid(),
  offlineId: z.uuid(),
  visitOfflineId: z.uuid(),
  kind: z.enum(['checkin', 'checkout']),
  attachmentOfflineId: z.uuid().optional(),
  capturedAt: z.iso.datetime({ offset: true }),
  latitude: evidenceLocationSchema.shape.latitude,
  longitude: evidenceLocationSchema.shape.longitude,
  accuracyM: evidenceLocationSchema.shape.accuracyM,
  distanceM: evidenceLocationSchema.shape.distanceM,
  radiusM: z.literal(100),
  desiredAccuracyM: z.literal(50),
  issues: z.array(visitEvidenceIssueSchema).max(5),
  justification: z.string().trim().min(10).max(500).optional(),
  status: z.enum(['pending', 'synced', 'action_required']),
  serverSyncedAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((evidence, context) => {
  if (Boolean(evidence.latitude) !== Boolean(evidence.longitude)) {
    context.addIssue({
      code: 'custom',
      path: ['latitude'],
      message: 'Latitude e longitude devem ser informadas juntas.',
    });
  }
  if (evidence.issues.length > 0 && !evidence.justification) {
    context.addIssue({ code: 'custom', path: ['justification'], message: 'Justifique a exceção para continuar.' });
  }
  if (!evidence.attachmentOfflineId && !evidence.issues.includes('camera_unavailable')) {
    context.addIssue({ code: 'custom', path: ['attachmentOfflineId'], message: 'A fotografia da fachada é obrigatória.' });
  }
});
export type VisitEvidenceIssue = z.infer<typeof visitEvidenceIssueSchema>;
export type LocalVisitEvidence = z.infer<typeof localVisitEvidenceSchema>;

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
  aggregateType: z.literal('visit_draft').default('visit_draft'),
  payload: draftSavedPayloadSchema,
}).strict();

const visitStartedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.started.v1'),
  aggregateType: z.literal('visit').default('visit'),
  sequence: z.literal(1),
  payload: visitStartedPayloadSchema,
}).strict();

const visitStockSavedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.stock.saved.v1'),
  aggregateType: z.literal('visit').default('visit'),
  sequence: z.number().int().min(2),
  payload: visitStockSavedPayloadSchema,
}).strict();

const visitPricesSavedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.prices.saved.v1'),
  aggregateType: z.literal('visit').default('visit'),
  sequence: z.number().int().min(3),
  payload: visitPricesSavedPayloadSchema,
}).strict();

const visitCommercialActionsSavedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.commercial-actions.saved.v1'),
  aggregateType: z.literal('visit').default('visit'),
  sequence: z.number().int().min(4),
  payload: visitCommercialActionsSavedPayloadSchema,
}).strict();

const visitScrapSavedOfflineOutboxEventSchema = offlineOutboxBaseSchema.extend({
  operation: z.literal('visit.scrap.saved.v1'),
  aggregateType: z.literal('visit').default('visit'),
  sequence: z.number().int().min(5),
  payload: visitScrapSavedPayloadSchema,
}).strict();

export const offlineOutboxEventSchema = z.discriminatedUnion('operation', [
  legacyOfflineOutboxEventSchema,
  visitStartedOfflineOutboxEventSchema,
  visitStockSavedOfflineOutboxEventSchema,
  visitPricesSavedOfflineOutboxEventSchema,
  visitCommercialActionsSavedOfflineOutboxEventSchema,
  visitScrapSavedOfflineOutboxEventSchema,
]);
export type OfflineOutboxEvent = z.infer<typeof offlineOutboxEventSchema>;
