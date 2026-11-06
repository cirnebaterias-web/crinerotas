import { z } from 'zod';

const serverSchema = z.object({
  GOOGLE_SALES_SYNC_SPREADSHEET_ID: z.string().regex(/^[a-zA-Z0-9_-]{20,160}$/),
  GOOGLE_SALES_SYNC_SCHEDULE_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID: z.uuid().transform((value) => value.toLowerCase()),
});
const schema = serverSchema.extend({
  GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: z.email().endsWith('.iam.gserviceaccount.com'),
  GOOGLE_SALES_SYNC_PRIVATE_KEY: z.string().min(100).max(16000),
});
export type SalesSyncServerConfig = { spreadsheetId: string; scheduleEnabled: boolean; schedulerActorId: string };
export type SalesSheetConfig = {
  spreadsheetId: string; email: string; privateKey: string;
  scheduleEnabled: boolean; schedulerActorId: string;
};
export type SalesSheetConfigState =
  | { configured: true; reason: 'ready'; config: SalesSheetConfig }
  | { configured: false; reason: 'disabled' | 'missing_configuration' | 'invalid_configuration' };

/** The BFF never acquires Google data and therefore needs no Google credential. */
export function readSalesSyncServerConfig(env: Record<string, string | undefined>):
  { configured: true; reason: 'ready'; config: SalesSyncServerConfig } | Extract<SalesSheetConfigState, { configured: false }> {
  if (env.GOOGLE_SALES_SYNC_ENABLED === undefined || env.GOOGLE_SALES_SYNC_ENABLED === 'false') {
    return { configured: false, reason: 'disabled' };
  }
  if (env.GOOGLE_SALES_SYNC_ENABLED !== 'true') return { configured: false, reason: 'invalid_configuration' };
  const required = ['GOOGLE_SALES_SYNC_SPREADSHEET_ID', 'GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID'] as const;
  if (required.some((key) => !env[key]?.trim())) return { configured: false, reason: 'missing_configuration' };
  const result = serverSchema.safeParse(env);
  if (!result.success) return { configured: false, reason: 'invalid_configuration' };
  return { configured: true, reason: 'ready', config: {
    spreadsheetId: result.data.GOOGLE_SALES_SYNC_SPREADSHEET_ID,
    scheduleEnabled: result.data.GOOGLE_SALES_SYNC_SCHEDULE_ENABLED === 'true',
    schedulerActorId: result.data.GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID,
  } };
}

export function readSalesSheetSyncConfig(env: Record<string, string | undefined>): SalesSheetConfigState {
  const server = readSalesSyncServerConfig(env);
  if (!server.configured) return server;
  if (!env.GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL?.trim() || !env.GOOGLE_SALES_SYNC_PRIVATE_KEY?.trim()) {
    return { configured: false, reason: 'missing_configuration' };
  }
  const result = schema.safeParse(env);
  if (!result.success) return { configured: false, reason: 'invalid_configuration' };
  return { configured: true, reason: 'ready', config: { ...server.config,
    email: result.data.GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL,
    privateKey: result.data.GOOGLE_SALES_SYNC_PRIVATE_KEY.replace(/\\n/g, '\n'),
  } };
}
