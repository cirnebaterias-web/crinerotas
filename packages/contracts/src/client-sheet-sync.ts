import { z } from 'zod';
import { clientImportIssueSchema } from './client-imports';

export const clientSheetHeaders = [
  'Razão Social', 'CNPJ/CPF', 'Nome fantasia', 'Carteira', 'Status', 'Cidade', 'Bairro',
  'Latitude', 'Longitude', 'Endereço completo', 'Tipo de cliente', 'Grupo empresarial',
  'Heliar service', 'TIPO', 'CLiente Estratégico', 'Status Geo', 'Endereço encontrado Google',
  'Precisão Google', 'Última consulta Geo', 'Endereço consultado', 'Google Place ID',
] as const;
export const clientSheetSyncPath = '/api/v1/client-sync';
export const clientSheetTimeZone = 'America/Sao_Paulo';
export const clientSheetSyncRequestSchema = z.discriminatedUnion('trigger', [
  z.object({ trigger: z.literal('manual'), idempotencyKey: z.uuid().transform((id) => id.toLowerCase()) }).strict(),
  z.object({ trigger: z.literal('scheduled') }).strict(),
]);
export const clientSheetSyncResultSchema = z.object({
  id: z.uuid(), sourceKey: z.string(),
  status: z.enum(['running', 'completed', 'completed_with_pending', 'failed']),
  trigger: z.enum(['manual', 'scheduled']),
  startedAt: z.iso.datetime({ offset: true }), completedAt: z.iso.datetime({ offset: true }).nullable(),
  acceptedCount: z.number().int().nonnegative(), pendingCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(), issues: z.array(clientImportIssueSchema).max(10000),
  batchId: z.uuid().nullable(), errorCode: z.string().nullable(),
}).strict();
export const clientSheetSyncStatusSchema = z.object({
  configured: z.boolean(), reason: z.enum(['ready', 'disabled', 'missing_configuration', 'invalid_configuration']),
  scheduleEnabled: z.boolean(), timeZone: z.literal(clientSheetTimeZone),
  times: z.tuple([z.literal('06:00'), z.literal('13:00')]),
  latest: clientSheetSyncResultSchema.nullable(),
}).strict();
export type ClientSheetSyncRequest = z.infer<typeof clientSheetSyncRequestSchema>;
export type ClientSheetSyncResult = z.infer<typeof clientSheetSyncResultSchema>;
export type ClientSheetSyncStatus = z.infer<typeof clientSheetSyncStatusSchema>;

// The slot belongs to the business timezone, never the machine's locale.
export function clientSheetScheduledSlot(now: Date): string | null {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: clientSheetTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  if (parts.hour !== '06' && parts.hour !== '13') return null;
  return `${parts.year}-${parts.month}-${parts.day}@${parts.hour}:00`;
}
