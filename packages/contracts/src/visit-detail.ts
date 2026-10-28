import { z } from 'zod';

const decimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/u);
const nonNegativeDecimalStringSchema = decimalStringSchema.refine((value) => Number(value) >= 0);
const timestampSchema = z.iso.datetime({ offset: true });

export const visitDetailPath = (visitId: string) => `/api/v1/visits/${visitId}`;
export const attachmentDownloadUrlPath = (attachmentId: string) =>
  `/api/v1/attachments/${attachmentId}/download-url`;
export const attachmentDownloadUrlResponseSchema = z.object({
  schemaVersion: z.literal(1),
  attachmentId: z.uuid(),
  url: z.string().url(),
  expiresInSeconds: z.literal(60),
}).strict();
export type AttachmentDownloadUrlResponse = z.infer<typeof attachmentDownloadUrlResponseSchema>;

export const visitDetailEmptySectionSchema = z.object({
  state: z.enum(['absent', 'unknown_to_server']),
}).strict();

export const visitDetailContextSchema = z.object({
  serviceDate: z.iso.date(),
  route: z.object({
    id: z.uuid(),
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
  }).strict(),
  stop: z.object({
    id: z.uuid(),
    plannedOrder: z.number().int().positive().max(50),
    priority: z.number().int().min(0).max(9),
  }).strict(),
  client: z.object({
    id: z.uuid(),
    externalReference: z.string().trim().min(1).max(120).nullable(),
    name: z.string().trim().min(1).max(160),
    address: z.string().trim().min(1).max(300),
  }).strict(),
  seller: z.object({ id: z.uuid(), displayName: z.string().trim().min(1).max(120) }).strict(),
  parameterSet: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict(),
}).strict();

const stockSectionSchema = z.discriminatedUnion('state', [
  visitDetailEmptySectionSchema,
  z.object({
    state: z.literal('available'),
    recordedAt: timestampSchema,
    heliarQuantity: z.number().int().nonnegative(),
    mouraQuantity: z.number().int().nonnegative(),
    ownLines: z.array(z.object({
      brand: z.string().trim().min(1).max(80),
      model: z.string().trim().min(1).max(120),
      quantity: z.number().int().nonnegative(),
      productCode: z.string().trim().min(1).max(60).nullable().optional(),
      sku: z.string().trim().min(1).max(80).nullable().optional(),
      unitWeightKg: nonNegativeDecimalStringSchema.nullable().optional(),
      catalogVersion: z.number().int().positive().nullable().optional(),
      weightSource: z.enum(['catalog', 'fallback_15kg']).nullable().optional(),
    }).strict()).max(200),
    competitorLines: z.array(z.object({
      brand: z.string().trim().min(1).max(80),
      amperage: z.number().int().positive().max(999),
      technology: z.string().trim().min(1).max(60),
      quantity: z.number().int().nonnegative(),
      otherBrand: z.string().trim().min(1).max(80).optional(),
    }).strict()).max(200),
    observation: z.string().trim().min(1).max(500).nullable(),
  }).strict(),
]);

const pricesSectionSchema = z.discriminatedUnion('state', [
  visitDetailEmptySectionSchema,
  z.object({
    state: z.literal('available'),
    recordedAt: timestampSchema,
    availability: z.enum(['available', 'unavailable']),
    unavailableReason: z.object({ id: z.uuid(), label: z.string().trim().min(1).max(120) }).strict().nullable(),
    quotations: z.array(z.object({
      id: z.uuid(),
      competitor: z.object({ id: z.uuid(), label: z.string().trim().min(1).max(120) }).strict(),
      productCode: z.string().trim().min(1).max(60).nullable(),
      modelOrAmperage: z.string().trim().min(1).max(120),
      technology: z.object({ id: z.uuid(), label: z.string().trim().min(1).max(120) }).strict(),
      priceBrl: decimalStringSchema,
      condition: z.object({ id: z.uuid(), label: z.string().trim().min(1).max(120) }).strict(),
      observation: z.string().trim().min(1).max(500).nullable(),
    }).strict()).max(25),
  }).strict(),
]);

const actionsSectionSchema = z.discriminatedUnion('state', [
  visitDetailEmptySectionSchema,
  z.object({
    state: z.literal('available'),
    recordedAt: timestampSchema,
    ownAcknowledgements: z.array(z.object({
      actionId: z.uuid(), title: z.string().trim().min(1).max(120), presented: z.literal(true),
    }).strict()).max(50),
    competitor: z.object({
      availability: z.enum(['not_identified', 'identified']),
      actions: z.array(z.object({
        id: z.uuid(),
        competitorId: z.uuid(),
        actionType: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(1200),
        validFrom: z.iso.date(),
        validUntil: z.iso.date(),
      }).strict()).max(10),
    }).strict(),
  }).strict(),
]);

const scrapSectionSchema = z.discriminatedUnion('state', [
  visitDetailEmptySectionSchema,
  z.object({
    state: z.literal('available'),
    recordedAt: timestampSchema,
    availability: z.enum(['none', 'collected', 'scheduled']),
    collectedWeightKg: nonNegativeDecimalStringSchema.nullable(),
    scheduledWeightKg: nonNegativeDecimalStringSchema.nullable(),
    collection: z.object({
      id: z.uuid(), collectedAt: timestampSchema, receiptNumber: z.string().trim().min(1).max(120),
      destinationName: z.string().trim().min(1).max(300),
    }).strict().nullable(),
    schedule: z.object({
      id: z.uuid(), desiredDate: z.iso.date(), period: z.enum(['morning', 'afternoon']),
      status: z.string().trim().min(1).max(40), observation: z.string().trim().min(1).max(1200).nullable(),
    }).strict().nullable(),
  }).strict().superRefine((value, context) => {
    if ((value.availability === 'collected') !== Boolean(value.collection) ||
        (value.availability === 'scheduled') !== Boolean(value.schedule)) {
      context.addIssue({ code: 'custom', path: ['availability'], message: 'Conteúdo de sucata incompatível.' });
    }
  }),
]);

const resultSectionSchema = z.discriminatedUnion('state', [
  visitDetailEmptySectionSchema,
  z.object({
    state: z.literal('available'),
    outcome: z.literal('completed'),
    deviceCompletedAt: timestampSchema,
    serverCompletedAt: timestampSchema,
  }).strict(),
]);

export const visitDetailLocationSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('withheld') }).strict(),
  z.object({ state: z.literal('unknown_to_server') }).strict(),
  z.object({
    state: z.literal('available'),
    latitude: decimalStringSchema,
    longitude: decimalStringSchema,
    accuracyM: nonNegativeDecimalStringSchema.nullable(),
    distanceM: nonNegativeDecimalStringSchema.nullable(),
    capturedAt: timestampSchema,
  }).strict(),
]);

export const visitDetailEvidenceSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('withheld') }).strict(),
  z.object({
    state: z.literal('available'),
    items: z.array(z.object({
      id: z.uuid(),
      purpose: z.enum(['visit_checkin', 'visit_checkout', 'commercial_action_evidence', 'scrap_receipt']),
      contentType: z.enum(['image/jpeg', 'image/webp']),
      byteSize: z.number().int().positive().max(2 * 1024 * 1024),
      capturedAt: timestampSchema,
      verifiedAt: timestampSchema,
      downloadUrlPath: z.string().regex(/^\/api\/v1\/attachments\/[0-9a-f-]{36}\/download-url$/u),
    }).strict()).max(20),
  }).strict(),
]);

export const visitDetailResponseSchema = z.object({
  schemaVersion: z.literal(1),
  visitId: z.uuid(),
  context: visitDetailContextSchema,
  status: z.enum(['in_progress', 'completed']),
  deviceStartedAt: timestampSchema,
  serverStartedAt: timestampSchema,
  deviceCompletedAt: timestampSchema.nullable(),
  serverCompletedAt: timestampSchema.nullable(),
  lastKnownUpdateAt: timestampSchema,
  serverVisibilityNote: z.literal(
    'Somente dados recebidos e confirmados pelo servidor estão presentes; conteúdo ainda apenas no aparelho não é conhecido.',
  ),
  sections: z.object({
    stock: stockSectionSchema,
    competitorPrices: pricesSectionSchema,
    commercialActions: actionsSectionSchema,
    scrap: scrapSectionSchema,
    result: resultSectionSchema,
  }).strict(),
  synchronization: z.object({
    status: z.enum(['confirmed', 'recoverable_error', 'action_required']),
    occurredAt: timestampSchema,
    receivedAt: timestampSchema,
    confirmedAt: timestampSchema.nullable(),
    attemptCount: z.number().int().positive(),
    lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).nullable(),
  }).strict(),
  exceptions: z.array(z.object({
    kind: z.enum(['camera_unavailable', 'gps_unavailable', 'gps_low_accuracy', 'outside_radius', 'client_location_missing']),
    message: z.string().trim().min(1).max(500),
    capturedAt: timestampSchema,
  }).strict()).max(10),
  location: visitDetailLocationSchema,
  evidence: visitDetailEvidenceSchema,
  timeline: z.array(z.object({
    action: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
    origin: z.enum(['web', 'pwa', 'cli', 'system']),
    occurredAt: timestampSchema,
  }).strict()).max(100),
}).strict();

export type VisitDetailResponse = z.infer<typeof visitDetailResponseSchema>;
