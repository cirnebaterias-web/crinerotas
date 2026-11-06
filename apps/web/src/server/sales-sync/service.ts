import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readSalesSyncServerConfig, type SalesSyncServerConfig } from '@cirne/config/sales-sync';
import { salesScheduledSlot, salesSyncBeginResultSchema, salesSyncDatabaseStatusSchema, salesSyncStatusSchema,
  salesSyncResultSchema, salesSyncStageRequestSchema, salesSyncStageResultSchema, salesSyncPublishRequestSchema,
  salesSyncFailRequestSchema, salesTimeZone, salesScheduledTime, type SalesSyncRequest, type MeResponse } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RouteRequestError } from '../routes/http';
import { salesSyncRpc } from './http';

export function salesSourceKey(config: Pick<SalesSyncServerConfig, 'spreadsheetId'>) {
  return createHash('sha256').update(`${config.spreadsheetId}:Vendas`).digest('hex');
}
function configured(env: Record<string, string | undefined>) {
  const state = readSalesSyncServerConfig(env);
  if (!state.configured) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'A integração de vendas está desativada ou precisa de configuração.', false);
  return state.config;
}
export async function getSalesSyncStatus(client: SupabaseClient, env: Record<string, string | undefined> = process.env) {
  const state = readSalesSyncServerConfig(env);
  const database = state.configured ? salesSyncDatabaseStatusSchema.parse(await salesSyncRpc(client, 'get_sales_sheet_sync_status', {
    p_source_key: salesSourceKey(state.config),
  })) : { latestRun: null, lastPublishedRun: null };
  return salesSyncStatusSchema.parse({ ...database, configured: state.configured, reason: state.reason,
    scheduleEnabled: state.configured && state.config.scheduleEnabled, timeZone: salesTimeZone, time: salesScheduledTime,
    lastSuccessAt: database.lastPublishedRun?.completedAt ?? null,
  });
}
export async function beginSalesSync(client: SupabaseClient, identity: MeResponse, command: SalesSyncRequest,
  origin: 'cli' | 'web', options: { env?: Record<string, string | undefined>; clock?: () => Date } = {}) {
  const config = configured(options.env ?? process.env);
  if (config.schedulerActorId !== identity.id || origin !== 'cli' ||
    (command.trigger === 'scheduled' && !config.scheduleEnabled)) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Importação não autorizada para esta identidade.', false);
  }
  const requestKey = command.trigger === 'manual' ? command.idempotencyKey : salesScheduledSlot((options.clock ?? (() => new Date()))());
  if (!requestKey) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Agendamento permitido entre 06:15 e 06:59 em São Paulo.', false);
  return salesSyncBeginResultSchema.parse(await salesSyncRpc(client, 'begin_sales_sheet_sync', {
    p_source_key: salesSourceKey(config), p_request_key: requestKey, p_trigger: command.trigger,
  }));
}
export async function stageSalesSync(client: SupabaseClient, runId: string, command: z.infer<typeof salesSyncStageRequestSchema>) {
  return salesSyncStageResultSchema.parse(await salesSyncRpc(client, 'stage_sales_sheet_sync', {
    p_run_id: runId, p_lease_token: command.leaseToken, p_chunk_index: command.chunkIndex,
    p_chunk_hash: command.chunkHash, p_rows: command.rows,
  }));
}
export async function publishSalesSync(client: SupabaseClient, runId: string, command: z.infer<typeof salesSyncPublishRequestSchema>) {
  return salesSyncResultSchema.parse(await salesSyncRpc(client, 'publish_sales_sheet_sync', {
    p_run_id: runId, p_lease_token: command.leaseToken, p_content_hash: command.contentHash,
    p_expected_row_count: command.expectedRowCount, p_parser_version: command.parserVersion, p_origin: 'cli',
  }));
}
export async function failSalesSync(client: SupabaseClient, runId: string, command: z.infer<typeof salesSyncFailRequestSchema>) {
  return salesSyncResultSchema.parse(await salesSyncRpc(client, 'fail_sales_sheet_sync', {
    p_run_id: runId, p_lease_token: command.leaseToken, p_error_code: command.errorCode,
  }));
}
