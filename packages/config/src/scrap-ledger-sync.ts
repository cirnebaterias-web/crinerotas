import { z } from 'zod';

const serverSchema = z.object({
  GOOGLE_SCRAP_SYNC_SPREADSHEET_ID: z.string().regex(/^[a-zA-Z0-9_-]{20,160}$/),
  GOOGLE_SCRAP_SYNC_SCHEDULE_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_SCRAP_SYNC_SCHEDULER_ACTOR_ID: z.uuid().transform((value) => value.toLowerCase()),
  GOOGLE_SCRAP_SYNC_PUBLIC_READ: z.enum(['true', 'false']).default('false'),
});
const schema = serverSchema.extend({
  GOOGLE_SCRAP_SYNC_SERVICE_ACCOUNT_EMAIL: z.email().endsWith('.iam.gserviceaccount.com'),
  GOOGLE_SCRAP_SYNC_PRIVATE_KEY: z.string().min(100).max(16000),
});
export type ScrapLedgerSyncServerConfig = { spreadsheetId: string; scheduleEnabled: boolean; schedulerActorId: string };
export type ScrapLedgerSheetConfig = ScrapLedgerSyncServerConfig & { publicRead: boolean; email?: string; privateKey?: string };
export type ScrapLedgerConfigState =
  | { configured: true; reason: 'ready'; config: ScrapLedgerSheetConfig }
  | { configured: false; reason: 'disabled' | 'missing_configuration' | 'invalid_configuration' };

export function readScrapLedgerSyncServerConfig(env: Record<string, string | undefined>) {
  if (env.GOOGLE_SCRAP_SYNC_ENABLED === undefined || env.GOOGLE_SCRAP_SYNC_ENABLED === 'false') return { configured: false, reason: 'disabled' } as const;
  if (env.GOOGLE_SCRAP_SYNC_ENABLED !== 'true') return { configured: false, reason: 'invalid_configuration' } as const;
  if (!env.GOOGLE_SCRAP_SYNC_SPREADSHEET_ID?.trim() || !env.GOOGLE_SCRAP_SYNC_SCHEDULER_ACTOR_ID?.trim()) return { configured: false, reason: 'missing_configuration' } as const;
  const parsed = serverSchema.safeParse(env);
  if (!parsed.success) return { configured: false, reason: 'invalid_configuration' } as const;
  return { configured: true, reason: 'ready', config: { spreadsheetId: parsed.data.GOOGLE_SCRAP_SYNC_SPREADSHEET_ID,
    scheduleEnabled: parsed.data.GOOGLE_SCRAP_SYNC_SCHEDULE_ENABLED === 'true', schedulerActorId: parsed.data.GOOGLE_SCRAP_SYNC_SCHEDULER_ACTOR_ID } } as const;
}

export function readScrapLedgerSheetConfig(env: Record<string, string | undefined>): ScrapLedgerConfigState {
  const server = readScrapLedgerSyncServerConfig(env);
  if (!server.configured) return server;
  if (env.GOOGLE_SCRAP_SYNC_PUBLIC_READ === 'true') return { configured: true, reason: 'ready', config: { ...server.config, publicRead: true } };
  if (!env.GOOGLE_SCRAP_SYNC_SERVICE_ACCOUNT_EMAIL?.trim() || !env.GOOGLE_SCRAP_SYNC_PRIVATE_KEY?.trim()) return { configured: false, reason: 'missing_configuration' };
  const parsed = schema.safeParse(env);
  if (!parsed.success) return { configured: false, reason: 'invalid_configuration' };
  return { configured: true, reason: 'ready', config: { ...server.config, publicRead: false, email: parsed.data.GOOGLE_SCRAP_SYNC_SERVICE_ACCOUNT_EMAIL,
    privateKey: parsed.data.GOOGLE_SCRAP_SYNC_PRIVATE_KEY.replace(/\\n/g, '\n') } };
}
