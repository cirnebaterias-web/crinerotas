import { z } from 'zod';
import { clientExternalReferenceSchema } from './client-reference';

export const clientImportHeaders = [
  'referencia_externa', 'nome', 'endereco', 'latitude', 'longitude',
  'referencia_carteira', 'vendedor_email', 'status',
] as const;

export const clientImportRowSchema = z.object({
  rowNumber: z.number().int().min(2),
  externalReference: clientExternalReferenceSchema,
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  portfolioReference: z.string().trim().max(120).nullable(),
  sellerEmail: z.email().max(254),
  status: z.enum(['active', 'archived']),
}).strict();

export const clientImportIssueSchema = z.object({
  rowNumber: z.number().int().min(1),
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(300),
}).strict();

export const clientImportPreviewSchema = z.object({
  schemaVersion: z.literal(1),
  sourceName: z.string().min(1).max(255),
  sourceChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  totalCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  rows: z.array(clientImportRowSchema).max(5000),
  issues: z.array(clientImportIssueSchema).max(10000),
}).strict().superRefine((value, context) => {
  if (value.acceptedCount !== value.rows.length) {
    context.addIssue({ code: 'custom', path: ['acceptedCount'], message: 'acceptedCount deve corresponder às linhas aceitas.' });
  }
  if (value.totalCount !== value.acceptedCount + value.rejectedCount) {
    context.addIssue({ code: 'custom', path: ['totalCount'], message: 'totalCount deve corresponder à soma dos resultados.' });
  }
});

export const executeClientImportRequestSchema = clientImportPreviewSchema;

export const clientImportBatchSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  sourceName: z.string(),
  sourceChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['completed', 'completed_with_rejections', 'failed']),
  totalCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  importedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  replayed: z.boolean(),
  issues: z.array(clientImportIssueSchema),
}).strict();

export const importedClientSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  externalReference: clientExternalReferenceSchema,
  name: z.string(),
  address: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  portfolioReference: z.string().nullable(),
  sellerId: z.uuid().nullable(),
  sellerEmail: z.string().nullable(),
  status: z.enum(['active', 'archived']),
  version: z.number().int().positive(),
}).strict();

export const clientListResponseSchema = z.object({
  schemaVersion: z.literal(1),
  clients: z.array(importedClientSchema),
}).strict();

export type ClientImportRow = z.infer<typeof clientImportRowSchema>;
export type ClientImportIssue = z.infer<typeof clientImportIssueSchema>;
export type ClientImportPreview = z.infer<typeof clientImportPreviewSchema>;
export type ClientImportBatch = z.infer<typeof clientImportBatchSchema>;
export type ImportedClient = z.infer<typeof importedClientSchema>;

export const clientImportsPath = '/api/v1/client-imports';
export const clientImportsValidatePath = '/api/v1/client-imports/validate';
export const clientImportPath = (batchId: string) => `/api/v1/client-imports/${encodeURIComponent(batchId)}`;
