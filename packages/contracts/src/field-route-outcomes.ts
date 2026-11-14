import { z } from 'zod';

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const normalizedText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);

export const clientClassificationCodes = [
  'acessorios_automotivos', 'autoeletricas', 'autopecas', 'casa_de_baterias',
  'centro_automotivo', 'concessionarias', 'frotista', 'generalista',
  'loja_lubrificantes_pneus', 'oficina_mecanica', 'outros', 'delivery', 'consumidor',
] as const;
export const clientClassificationCodeSchema = z.enum(clientClassificationCodes);
export const clientClassificationSchema = z.object({
  id: uuid,
  code: clientClassificationCodeSchema,
  label: normalizedText(1, 80),
  description: normalizedText(1, 500),
  displayOrder: z.number().int().min(1).max(13),
}).strict();
export const clientClassificationCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  values: z.array(clientClassificationSchema).length(13),
}).strict();

export const clientFieldProfileSchema = z.object({
  schemaVersion: z.literal(1),
  clientId: uuid,
  classificationId: uuid.nullable(),
  classificationCode: clientClassificationCodeSchema.nullable(),
  classificationLabel: z.string().trim().min(1).max(80).nullable(),
  operatingStatus: z.enum(['active', 'closed']),
  closedReason: z.string().trim().max(120).nullable(),
  closedObservation: z.string().trim().max(500).nullable(),
  closedAt: instant.nullable(),
}).strict();
export const managementClientFieldProfilesSchema = z.object({
  schemaVersion: z.literal(1), profiles: z.array(clientFieldProfileSchema).max(100),
}).strict();

export const sellerRouteClientSchema = z.object({
  id: uuid,
  externalReference: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300),
  portfolioReference: z.string().trim().max(120).nullable(),
  alreadyOnRoute: z.boolean(),
}).strict();
export const sellerRouteClientSearchResponseSchema = z.object({
  schemaVersion: z.literal(1),
  clients: z.array(sellerRouteClientSchema).max(30),
}).strict();

export const classifyClientCommandSchema = z.object({
  schemaVersion: z.literal(1), clientId: uuid, classificationCode: clientClassificationCodeSchema,
}).strict();
export const classifyClientResultSchema = z.object({
  schemaVersion: z.literal(1), clientId: uuid, classificationId: uuid,
  classificationCode: clientClassificationCodeSchema, classifiedAt: instant, replayed: z.boolean(),
}).strict();

export const clientOperatingStatusSchema = z.enum(['active', 'closed']);
export const closeClientCommandSchema = z.object({
  schemaVersion: z.literal(1), clientId: uuid, reason: normalizedText(1, 120),
  observation: normalizedText(1, 500).optional(),
}).strict();
export const closeClientResultSchema = z.object({
  schemaVersion: z.literal(1), clientId: uuid, operatingStatus: z.literal('closed'),
  closedAt: instant, replayed: z.boolean(),
}).strict();

export const routeStopSourceSchema = z.enum(['planned', 'seller_ad_hoc']);
export const extendSellerRouteCommandSchema = z.object({
  schemaVersion: z.literal(1), routeId: uuid, expectedVersion: z.number().int().positive(), clientId: uuid,
}).strict();
export const extendSellerRouteResultSchema = z.object({
  schemaVersion: z.literal(1), routeId: uuid, previousRouteVersionId: uuid, routeVersionId: uuid,
  versionNumber: z.number().int().positive(), routeVersionStopId: uuid,
  source: z.literal('seller_ad_hoc'), replayed: z.boolean(),
}).strict();

export const routeStopAttemptReasonCodes = [
  'client_closed', 'responsible_absent', 'client_unavailable', 'visit_refused',
  'reschedule_requested', 'access_blocked', 'address_not_found', 'business_closed', 'other',
] as const;
export const routeStopAttemptReasonCodeSchema = z.enum(routeStopAttemptReasonCodes);
export const routeStopAttemptEvidenceSchema = z.object({
  attachmentOfflineId: uuid,
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().max(10_000), capturedAt: instant,
}).strict();
export const recordRouteStopAttemptCommandSchema = z.object({
  schemaVersion: z.literal(1), offlineId: uuid, routeVersionStopId: uuid,
  reasonCode: routeStopAttemptReasonCodeSchema, observation: normalizedText(1, 500).optional(),
  evidence: routeStopAttemptEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.reasonCode === 'other' && !value.observation) {
    context.addIssue({ code: 'custom', path: ['observation'], message: 'Informe o motivo da visita não realizada.' });
  }
});
export const recordRouteStopAttemptResultSchema = z.object({
  schemaVersion: z.literal(1), attemptId: uuid, offlineId: uuid, routeVersionStopId: uuid,
  status: z.literal('not_completed'), reasonCode: routeStopAttemptReasonCodeSchema,
  recordedAt: instant, replayed: z.boolean(),
}).strict();

export const reserveRouteStopAttemptAttachmentCommandSchema = z.object({
  schemaVersion: z.literal(1), offlineId: uuid, attemptOfflineId: uuid,
  contentType: z.enum(['image/jpeg', 'image/webp']), byteSize: z.number().int().positive().max(2 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u), capturedAt: instant, expiresAt: instant,
}).strict();
export const routeStopAttemptAttachmentIntentResultSchema = z.object({
  schemaVersion: z.literal(1), attachmentId: uuid, offlineId: uuid, storagePath: z.string().min(1),
  signedUrl: z.url(), token: z.string().min(1), expiresInSeconds: z.number().int().positive(),
  alreadyVerified: z.boolean(), verifiedAt: instant.optional(),
}).strict();
export const routeStopAttemptAttachmentConfirmationSchema = z.object({
  schemaVersion: z.literal(1), attachmentId: uuid, offlineId: uuid,
  status: z.literal('verified'), verifiedAt: instant,
}).strict();
export const routeStopAttemptAttachmentConfirmRequestSchema = z.object({
  schemaVersion: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export type ClientClassificationCode = z.infer<typeof clientClassificationCodeSchema>;
export type ClassifyClientCommand = z.infer<typeof classifyClientCommandSchema>;
export type CloseClientCommand = z.infer<typeof closeClientCommandSchema>;
export type ExtendSellerRouteCommand = z.infer<typeof extendSellerRouteCommandSchema>;
export type RecordRouteStopAttemptCommand = z.infer<typeof recordRouteStopAttemptCommandSchema>;
export type RouteStopAttemptReasonCode = z.infer<typeof routeStopAttemptReasonCodeSchema>;
export type ReserveRouteStopAttemptAttachmentCommand = z.infer<typeof reserveRouteStopAttemptAttachmentCommandSchema>;
export type ClientFieldProfile = z.infer<typeof clientFieldProfileSchema>;
export type SellerRouteClient = z.infer<typeof sellerRouteClientSchema>;

export const clientClassificationCatalogPath = '/api/v1/client-classifications';
export const clientFieldProfilePath = (clientId: string) => `/api/v1/clients/${encodeURIComponent(clientId)}/field-profile`;
export const closeClientOperationsPath = (clientId: string) => `/api/v1/clients/${encodeURIComponent(clientId)}/operating-status`;
export const sellerRouteClientsPath = '/api/v1/me/route-clients';
export const extendSellerRoutePath = (routeId: string) => `/api/v1/routes/${encodeURIComponent(routeId)}/additional-client`;
export const routeStopAttemptPath = (routeVersionStopId: string) => `/api/v1/route-stops/${encodeURIComponent(routeVersionStopId)}/attempts`;
export const routeStopAttemptAttachmentPath = '/api/v1/route-stop-attempt-attachments';
export const routeStopAttemptAttachmentConfirmPath = (offlineId: string) => `${routeStopAttemptAttachmentPath}/${encodeURIComponent(offlineId)}/confirm`;
