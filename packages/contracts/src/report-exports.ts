import { z } from 'zod';
import { fieldIntelligenceFilterObjectSchema } from './field-intelligence';

export const reportExportViewSchema = z.enum([
  'management_day',
  'field_intelligence',
  'scrap_agenda',
  'pilot_metrics',
]);
export const reportExportFormatSchema = z.enum(['csv', 'xlsx']);

const outputShape = { format: reportExportFormatSchema } as const;

export const managementDayExportQuerySchema = z.object({
  view: z.literal('management_day'),
  ...outputShape,
  serviceDate: z.iso.date(),
}).strict();

export const fieldIntelligenceExportQuerySchema = fieldIntelligenceFilterObjectSchema
  .omit({ cursor: true })
  .extend({ view: z.literal('field_intelligence'), ...outputShape })
  .strict()
  .superRefine((filters, context) => {
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

const scrapPeriodSchema = z.enum(['morning', 'afternoon']);
export const scrapAgendaExportQuerySchema = z.object({
  view: z.literal('scrap_agenda'),
  ...outputShape,
  from: z.iso.date(),
  to: z.iso.date(),
  status: z.literal('pending').default('pending'),
  period: scrapPeriodSchema.optional(),
  sellerId: z.uuid().optional(),
  clientId: z.uuid().optional(),
}).strict().refine(({ from, to }) => from <= to, {
  path: ['to'], message: 'A data final deve ser igual ou posterior à inicial.',
});

export const pilotMetricsExportQuerySchema = z.object({
  view: z.literal('pilot_metrics'),
  ...outputShape,
  from: z.iso.date(),
  to: z.iso.date(),
  sellerId: z.uuid().optional(),
  clientId: z.uuid().optional(),
}).strict().refine(({ from, to }) => from <= to, {
  path: ['to'], message: 'A data final deve ser igual ou posterior à inicial.',
});

export const reportExportQuerySchema = z.discriminatedUnion('view', [
  managementDayExportQuerySchema,
  fieldIntelligenceExportQuerySchema,
  scrapAgendaExportQuerySchema,
  pilotMetricsExportQuerySchema,
]);

export const reportExportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  view: reportExportViewSchema,
  format: reportExportFormatSchema,
  fileName: z.string().regex(/^cirne-[a-z0-9-]+-\d{4}-\d{2}-\d{2}(?:-a-\d{4}-\d{2}-\d{2})?\.(?:csv|xlsx)$/u),
  contentType: z.enum([
    'text/csv; charset=utf-8',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  rowCount: z.number().int().nonnegative().max(10_000),
}).strict();

export type ReportExportView = z.infer<typeof reportExportViewSchema>;
export type ReportExportFormat = z.infer<typeof reportExportFormatSchema>;
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;
export type ReportExportMetadata = z.infer<typeof reportExportMetadataSchema>;

export const reportExportsPath = '/api/v1/reports/exports';
