import { z } from 'zod';
import { competitorCommercialActionTypeSchema } from './commercial-action-types';

const timestampSchema = z.iso.datetime({ offset: true });
const decimalStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u);
const labelSchema = z.string().trim().min(1).max(160);
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{8,1024}$/u);

export const fieldIntelligenceSectionSchema = z.enum([
  'stock',
  'prices',
  'actions',
  'scrap',
  'results',
]);

const fieldIntelligenceFilterObjectSchema = z.object({
  section: fieldIntelligenceSectionSchema,
  from: z.iso.date(),
  to: z.iso.date(),
  sellerId: z.uuid().optional(),
  clientId: z.uuid().optional(),
  competitorId: z.uuid().optional(),
  actionType: competitorCommercialActionTypeSchema.optional(),
  cursor: cursorSchema.optional(),
}).strict();

export const fieldIntelligenceFilterSchema = fieldIntelligenceFilterObjectSchema.superRefine((filters, context) => {
  if (filters.from > filters.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'A data final deve ser igual ou posterior à inicial.' });
  }
  if (filters.competitorId && !['prices', 'actions'].includes(filters.section)) {
    context.addIssue({ code: 'custom', path: ['competitorId'], message: 'Concorrente só filtra Preços ou Ações.' });
  }
  if (filters.actionType && filters.section !== 'actions') {
    context.addIssue({ code: 'custom', path: ['actionType'], message: 'Tipo de ação só filtra Ações.' });
  }
});

const subjectSchema = z.object({ id: z.uuid(), name: labelSchema }).strict();
const commonRecordShape = {
  recordId: z.uuid(),
  visitId: z.uuid(),
  serviceDate: z.iso.date(),
  seller: subjectSchema,
  client: subjectSchema,
  confirmedAt: timestampSchema,
};

const ownStockLineSchema = z.object({
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  quantity: z.number().int().nonnegative(),
  productCode: z.string().trim().min(1).max(60).nullable().optional(),
  sku: z.string().trim().min(1).max(80).nullable().optional(),
  unitWeightKg: decimalStringSchema.nullable().optional(),
  catalogVersion: z.number().int().positive().nullable().optional(),
  weightSource: z.enum(['catalog', 'fallback_15kg']).nullable().optional(),
}).strict();

const competitorStockLineSchema = z.object({
  brand: z.string().trim().min(1).max(80),
  amperage: z.number().int().positive().max(999),
  technology: z.string().trim().min(1).max(60),
  quantity: z.number().int().nonnegative(),
  otherBrand: z.string().trim().min(1).max(80).optional(),
}).strict();

export const fieldIntelligenceStockRecordSchema = z.object({
  ...commonRecordShape,
  heliarQuantity: z.number().int().nonnegative(),
  mouraQuantity: z.number().int().nonnegative(),
  ownLines: z.array(ownStockLineSchema).max(200),
  competitorLines: z.array(competitorStockLineSchema).max(200),
}).strict();

const quotationSchema = z.object({
  id: z.uuid(),
  competitor: z.object({ id: z.uuid(), label: labelSchema }).strict(),
  modelOrAmperage: z.string().trim().min(1).max(120),
  technology: z.object({ id: z.uuid(), label: labelSchema }).strict(),
  priceBrl: decimalStringSchema,
  condition: z.object({ id: z.uuid(), label: labelSchema }).strict(),
  observation: z.string().trim().min(1).max(500).nullable(),
}).strict();

export const fieldIntelligencePriceRecordSchema = z.object({
  ...commonRecordShape,
  availability: z.enum(['available', 'unavailable']),
  unavailableReason: z.object({ id: z.uuid(), label: labelSchema }).strict().nullable(),
  quotations: z.array(quotationSchema).max(25),
}).strict();

const competitorActionSchema = z.object({
  id: z.uuid(),
  competitor: z.object({ id: z.uuid(), label: labelSchema }).strict(),
  actionType: competitorCommercialActionTypeSchema,
  otherType: z.string().trim().min(1).max(120).nullable(),
  description: z.string().trim().min(1).max(1200),
  validFrom: z.iso.date(),
  validUntil: z.iso.date(),
}).strict();

export const fieldIntelligenceActionRecordSchema = z.object({
  ...commonRecordShape,
  availability: z.enum(['not_identified', 'identified']),
  actions: z.array(competitorActionSchema).max(10),
}).strict();

export const fieldIntelligenceScrapRecordSchema = z.object({
  ...commonRecordShape,
  availability: z.enum(['none', 'collected', 'scheduled']),
  collection: z.object({
    id: z.uuid(),
    actualWeightKg: decimalStringSchema,
    collectedAt: timestampSchema,
  }).strict().nullable(),
  schedule: z.object({
    id: z.uuid(),
    estimatedWeightKg: decimalStringSchema,
    desiredDate: z.iso.date(),
    period: z.enum(['morning', 'afternoon']),
    status: z.literal('pending'),
  }).strict().nullable(),
}).strict();

export const fieldIntelligenceResultRecordSchema = z.object({
  ...commonRecordShape,
  outcome: z.literal('completed'),
  deviceStartedAt: timestampSchema,
  serverStartedAt: timestampSchema,
  deviceCompletedAt: timestampSchema,
  serverCompletedAt: timestampSchema,
}).strict();

const responseBase = {
  schemaVersion: z.literal(1),
  filters: fieldIntelligenceFilterObjectSchema.omit({ cursor: true }),
  generatedAt: timestampSchema,
  lastConfirmedAt: timestampSchema.nullable(),
  nextCursor: cursorSchema.nullable(),
  serverVisibilityNote: z.literal(
    'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  ),
};

export const fieldIntelligenceResponseSchema = z.discriminatedUnion('section', [
  z.object({ ...responseBase, section: z.literal('stock'), indicators: z.object({
    records: z.number().int().nonnegative(),
    heliarQuantity: z.number().int().nonnegative(),
    mouraQuantity: z.number().int().nonnegative(),
    ownLineQuantity: z.number().int().nonnegative(),
    competitorLineQuantity: z.number().int().nonnegative(),
  }).strict(), records: z.array(fieldIntelligenceStockRecordSchema).max(50) }).strict(),
  z.object({ ...responseBase, section: z.literal('prices'), indicators: z.object({
    records: z.number().int().nonnegative(),
    quotations: z.number().int().nonnegative(),
    unavailableRecords: z.number().int().nonnegative(),
  }).strict(), records: z.array(fieldIntelligencePriceRecordSchema).max(50) }).strict(),
  z.object({ ...responseBase, section: z.literal('actions'), indicators: z.object({
    records: z.number().int().nonnegative(),
    identifiedRecords: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  }).strict(), records: z.array(fieldIntelligenceActionRecordSchema).max(50) }).strict(),
  z.object({ ...responseBase, section: z.literal('scrap'), indicators: z.object({
    records: z.number().int().nonnegative(),
    collectedRecords: z.number().int().nonnegative(),
    scheduledRecords: z.number().int().nonnegative(),
    collectedWeightKg: decimalStringSchema,
    scheduledWeightKg: decimalStringSchema,
  }).strict(), records: z.array(fieldIntelligenceScrapRecordSchema).max(50) }).strict(),
  z.object({ ...responseBase, section: z.literal('results'), indicators: z.object({
    records: z.number().int().nonnegative(),
    completedVisits: z.number().int().nonnegative(),
  }).strict(), records: z.array(fieldIntelligenceResultRecordSchema).max(50) }).strict(),
]);

export const fieldIntelligencePath = '/api/v1/reports/field-intelligence';
export type FieldIntelligenceSection = z.infer<typeof fieldIntelligenceSectionSchema>;
export type FieldIntelligenceFilter = z.infer<typeof fieldIntelligenceFilterSchema>;
export type FieldIntelligenceResponse = z.infer<typeof fieldIntelligenceResponseSchema>;
