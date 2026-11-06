import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readClientSheetSyncConfig, type ClientSheetConfig } from '@cirne/config/client-sheet-sync';
import { clientSheetScheduledSlot, clientSheetSyncResultSchema, clientSheetSyncStatusSchema,
  type ClientSheetSyncRequest, type MeResponse } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientImportRpc } from '../client-imports/http';
import { validateImportSellers } from '../client-imports/service';
import { RouteRequestError } from '../routes/http';
import { readGoogleClientSheet } from './google';
import { normalizeClientSheet } from './normalize';

const beginSchema = z.object({ runId: z.uuid(), leaseToken: z.uuid().nullable(),
  replayed: z.boolean(), result: clientSheetSyncResultSchema });
function sourceKey(config: ClientSheetConfig) {
  return createHash('sha256').update(`${config.spreadsheetId}:Base clientes`).digest('hex');
}
export async function getClientSheetSyncStatus(client: SupabaseClient, env: Record<string, string | undefined> = process.env) {
  const state = readClientSheetSyncConfig(env);
  const latest = state.configured ? await clientImportRpc(client, 'get_client_sheet_sync_status', {
    p_source_key: sourceKey(state.config),
  }) : null;
  return clientSheetSyncStatusSchema.parse({ configured: state.configured, reason: state.reason,
    scheduleEnabled: state.configured && state.config.scheduleEnabled,
    timeZone: 'America/Sao_Paulo', times: ['06:00', '13:00'], latest });
}
export async function synchronizeClientSheet(client: SupabaseClient, identity: MeResponse,
  command: ClientSheetSyncRequest, origin: 'web' | 'cli',
  options: { env?: Record<string, string | undefined>; clock?: () => Date;
    readSheet?: typeof readGoogleClientSheet } = {}) {
  const state = readClientSheetSyncConfig(options.env ?? process.env);
  if (!state.configured) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE',
    'A conexão Google Sheets ainda precisa ser configurada no servidor.', false);
  if (command.trigger === 'scheduled' && (!state.config.scheduleEnabled ||
    state.config.schedulerActorId !== identity.id || origin !== 'cli')) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Agendamento não autorizado para esta identidade.', false);
  }
  const requestKey = command.trigger === 'manual' ? command.idempotencyKey
    : clientSheetScheduledSlot((options.clock ?? (() => new Date()))());
  if (!requestKey) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Fora dos horários de atualização: 06h e 13h em São Paulo.', false);
  const run = beginSchema.parse(await clientImportRpc(client, 'begin_client_sheet_sync', {
    p_source_key: sourceKey(state.config), p_request_key: requestKey, p_trigger: command.trigger,
  }));
  if (run.replayed) return run.result;
  if (!run.leaseToken) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Atualização indisponível. Consulte o estado antes de tentar novamente.', true);
  try {
    const values = await (options.readSheet ?? readGoogleClientSheet)(state.config);
    const normalized = normalizeClientSheet(values, state.config.portfolios);
    const preview = await validateImportSellers(client, normalized.preview);
    return clientSheetSyncResultSchema.parse(await clientImportRpc(client, 'finish_client_sheet_sync', {
      p_run_id: run.runId, p_lease_token: run.leaseToken, p_command: preview,
      p_ignored_count: normalized.ignoredCount, p_origin: origin,
    }));
  } catch (error) {
    // The lease expires if the database itself is unreachable. Never replace the original failure.
    await clientImportRpc(client, 'fail_client_sheet_sync', { p_run_id: run.runId,
      p_lease_token: run.leaseToken, p_error_code: error instanceof RouteRequestError ? error.code : 'INTERNAL_ERROR',
    }).catch(() => undefined);
    throw error;
  }
}
