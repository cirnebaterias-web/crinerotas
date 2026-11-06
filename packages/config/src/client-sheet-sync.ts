import { z } from 'zod';

const schema = z.object({
  GOOGLE_CLIENT_SYNC_SPREADSHEET_ID: z.string().regex(/^[a-zA-Z0-9_-]{20,160}$/),
  GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL: z.email().endsWith('.iam.gserviceaccount.com'),
  GOOGLE_CLIENT_SYNC_PRIVATE_KEY: z.string().min(100).max(16000),
  GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON: z.string().min(2).max(64000),
  GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED: z.enum(['true', 'false']).default('false'),
  GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID: z.preprocess((v) => v === '' ? undefined : v, z.uuid().transform((id) => id.toLowerCase()).optional()),
});
export function normalizePortfolio(value: string) { return value.normalize('NFKC').trim().toUpperCase(); }
export type ClientSheetConfig = {
  spreadsheetId: string; email: string; privateKey: string; portfolios: Record<string, string>;
  scheduleEnabled: boolean; schedulerActorId?: string;
};
export type ClientSheetConfigState =
  | { configured: true; reason: 'ready'; config: ClientSheetConfig }
  | { configured: false; reason: 'disabled' | 'missing_configuration' | 'invalid_configuration' };

export function readClientSheetSyncConfig(env: Record<string, string | undefined>): ClientSheetConfigState {
  if (env.GOOGLE_CLIENT_SYNC_ENABLED === undefined || env.GOOGLE_CLIENT_SYNC_ENABLED === 'false') {
    return { configured: false, reason: 'disabled' };
  }
  if (env.GOOGLE_CLIENT_SYNC_ENABLED !== 'true') return { configured: false, reason: 'invalid_configuration' };
  const required = ['GOOGLE_CLIENT_SYNC_SPREADSHEET_ID', 'GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_CLIENT_SYNC_PRIVATE_KEY', 'GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON'] as const;
  if (required.some((key) => !env[key]?.trim())) return { configured: false, reason: 'missing_configuration' };
  try {
    const parsed = schema.parse(env);
    if (parsed.GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED === 'true' && !parsed.GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID) throw new Error();
    const raw: unknown = JSON.parse(parsed.GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON);
    // Preserve original keys until collision checks; Zod key transforms and JSON.parse
    // otherwise silently collapse distinct spellings or repeated JSON members.
    const mappings = z.record(z.string().min(1).max(120), z.email().max(254)).parse(raw);
    if (Object.keys(mappings).length > 500) throw new Error();
    const source = parsed.GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON;
    const sourceKeys = new Set<string>();
    for (const token of source.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (!source.slice(token.index + token[0].length).trimStart().startsWith(':')) continue;
      const key = normalizePortfolio(JSON.parse(token[0]) as string);
      if (sourceKeys.has(key)) throw new Error();
      sourceKeys.add(key);
    }
    const normalized = new Map<string, string>();
    for (const [name, email] of Object.entries(mappings)) {
      const key = normalizePortfolio(name);
      if (!key || normalized.has(key) || key === 'OUTROS' || key === 'VERIFICAR') throw new Error();
      normalized.set(key, email.toLowerCase());
    }
    return { configured: true, reason: 'ready', config: {
      spreadsheetId: parsed.GOOGLE_CLIENT_SYNC_SPREADSHEET_ID,
      email: parsed.GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL,
      privateKey: parsed.GOOGLE_CLIENT_SYNC_PRIVATE_KEY.replace(/\\n/g, '\n'),
      portfolios: Object.fromEntries(normalized), scheduleEnabled: parsed.GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED === 'true',
      schedulerActorId: parsed.GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID,
    } };
  } catch { return { configured: false, reason: 'invalid_configuration' }; }
}
