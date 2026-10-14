import { z } from 'zod';

const weightSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, 'Informe kg positivos.');
const revisionBase = {
  schemaVersion: z.literal(1), expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
};
export const reviseScrapCollectionRequestSchema = z.object({
  ...revisionBase, actualWeightKg: weightSchema, collectedAt: z.iso.datetime({ offset: true }),
  receiptNumber: z.string().trim().min(1).max(80),
  destinationType: z.enum(['headquarters', 'concentration_point']), concentrationPointId: z.uuid().optional(),
  divergenceObservation: z.string().trim().min(1).max(1000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.destinationType === 'concentration_point') !== Boolean(value.concentrationPointId)) {
    context.addIssue({ code: 'custom', path: ['concentrationPointId'], message: 'Selecione um ponto somente para concentração.' });
  }
});
export type ReviseScrapCollectionRequest = z.infer<typeof reviseScrapCollectionRequestSchema>;
export const reviseScrapReceiptRequestSchema = z.object({
  ...revisionBase, receivedWeightKg: weightSchema, receivedLocation: z.string().trim().min(1).max(300),
  observation: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type ReviseScrapReceiptRequest = z.infer<typeof reviseScrapReceiptRequestSchema>;
export const scrapCollectionRevisionPath = (collectionId: string) => `/api/v1/scrap/collections/${collectionId}`;
export const scrapCollectionRevisionsPath = (collectionId: string) => `/api/v1/scrap/collections/${collectionId}/revisions`;
const auditSnapshotSchema = z.object({
  actualWeightKg: z.string().optional(), collectedAt: z.string().optional(), receiptNumber: z.string().optional(),
  destinationType: z.string().optional(), concentrationPoint: z.object({
    id: z.uuid(), name: z.string(), address: z.string(),
  }).nullable().optional(),
  receivedWeightKg: z.string().optional(), receivedLocation: z.string().optional(),
  observation: z.string().nullable().optional(), receivedBy: z.object({ id: z.uuid(), displayName: z.string() }).optional(),
  receivedAt: z.string().optional(), status: z.string().optional(), version: z.number().int().positive().optional(),
  retentionUntil: z.string().nullable().optional(),
});
export const scrapCollectionRevisionSchema = z.object({
  id: z.uuid(), kind: z.enum(['collection', 'receipt']),
  actor: z.object({ id: z.uuid(), displayName: z.string() }).strict(),
  changedAt: z.iso.datetime({ offset: true }), reason: z.string().trim().min(1),
  before: auditSnapshotSchema.nullable(), after: auditSnapshotSchema.nullable(),
}).strict();
export const scrapCollectionRevisionsSchema = z.object({ schemaVersion: z.literal(1), revisions: z.array(scrapCollectionRevisionSchema) }).strict();
export type ScrapCollectionRevisions = z.infer<typeof scrapCollectionRevisionsSchema>;
