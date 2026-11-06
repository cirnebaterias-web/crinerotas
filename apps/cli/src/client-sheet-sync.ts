import { z } from 'zod';
import { clientSheetSyncPath, clientSheetSyncResultSchema, clientSheetSyncStatusSchema,
  type ClientSheetSyncRequest } from '@cirne/contracts';

export function safeSyncOrigin(value: string) {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use uma origem HTTPS ou localhost para a CLI.');
  }
  return url.origin;
}
export async function clientSheetSyncCommand(baseUrl: string, token: string,
  command: ClientSheetSyncRequest | null, transport: typeof fetch = fetch) {
  const response = await transport(new URL(clientSheetSyncPath, safeSyncOrigin(baseUrl)), {
    method: command ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(90_000),
    headers: { authorization: `Bearer ${token}`, ...(command ? { 'content-type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  if (!response.ok) throw new Error(`Atualização de clientes respondeu HTTP ${response.status}. Consulte a configuração e o estado da integração.`);
  const body: unknown = await response.json();
  return command ? clientSheetSyncResultSchema.parse(body) : clientSheetSyncStatusSchema.parse(body);
}

// Dedicated operator credentials are supplied only to the one-shot scheduler process.
export async function loginSheetSyncOperator(env: Record<string, string | undefined>, transport: typeof fetch = fetch) {
  const config = z.object({ SUPABASE_PUBLIC_URL: z.string().min(1), SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
    CIRNE_SHEET_SYNC_EMAIL: z.email(), CIRNE_SHEET_SYNC_PASSWORD: z.string().min(12).max(256) }).safeParse(env);
  if (!config.success) throw new Error('Configure a identidade técnica do agendador no arquivo privado de ambiente.');
  const origin = safeSyncOrigin(config.data.SUPABASE_PUBLIC_URL);
  const response = await transport(`${origin}/auth/v1/token?grant_type=password`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { apikey: config.data.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: config.data.CIRNE_SHEET_SYNC_EMAIL, password: config.data.CIRNE_SHEET_SYNC_PASSWORD }),
  });
  if (!response.ok) throw new Error('Não foi possível autenticar a identidade técnica do agendador.');
  const parsed = z.object({ access_token: z.string().min(1) }).safeParse(await response.json());
  if (!parsed.success) throw new Error('Resposta de autenticação inválida.');
  return parsed.data.access_token;
}
