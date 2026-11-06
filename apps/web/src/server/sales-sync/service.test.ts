import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeResponse, SalesSyncResult } from '@cirne/contracts';
import { salesSyncRpc } from './http';
import { beginSalesSync, failSalesSync, getSalesSyncStatus, publishSalesSync, salesSourceKey, stageSalesSync } from './service';
vi.mock('./http', () => ({ salesSyncRpc: vi.fn() }));
const rpc = vi.mocked(salesSyncRpc);
const client = {} as SupabaseClient;
const id = '11111111-1111-4111-8111-111111111111';
const lease = '22222222-2222-4222-8222-222222222222';
const identity: MeResponse = { id, displayName: 'Técnico sintético', status: 'active', roles: ['manager'], capabilities: ['sales.sync'], scopeIds: [] };
const env = { GOOGLE_SALES_SYNC_ENABLED: 'true', GOOGLE_SALES_SYNC_SPREADSHEET_ID: 'synthetic_sheet_identifier_123',
  GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com', GOOGLE_SALES_SYNC_PRIVATE_KEY: 'x'.repeat(100),
  GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID: id, GOOGLE_SALES_SYNC_SCHEDULE_ENABLED: 'true' };
const result: SalesSyncResult = { id, sourceKey: 'a'.repeat(64), status: 'collecting', trigger: 'manual',
  startedAt: '2026-11-03T09:15:00Z', completedAt: null, generationId: null, contentHash: null, parserVersion: null,
  sourceRowCount: 0, stagedRowCount: 0, unmatchedClientCount: 0, issueCount: 0, observedMinDate: null, observedMaxDate: null, errorCode: null };
beforeEach(() => { rpc.mockReset(); });
describe('sales sync BFF services', () => {
  it('returns safe disabled status without querying the source or database', async () => {
    expect(await getSalesSyncStatus(client, {})).toMatchObject({ configured: false, scheduleEnabled: false,
      reason: 'disabled', latestRun: null, lastPublishedRun: null, time: '06:15', timeZone: 'America/Sao_Paulo' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('separates latest attempt from last successful publication and hides configuration', async () => {
    rpc.mockResolvedValue({ latestRun: { ...result, status: 'failed' },
      lastPublishedRun: { ...result, status: 'published', completedAt: '2026-11-03T09:16:00Z' } });
    const status = await getSalesSyncStatus(client, env);
    expect(status.lastSuccessAt).toBe('2026-11-03T09:16:00Z');
    expect(JSON.stringify(status)).not.toContain(env.GOOGLE_SALES_SYNC_SPREADSHEET_ID);
    expect(JSON.stringify(status)).not.toContain(env.GOOGLE_SALES_SYNC_PRIVATE_KEY);
    expect(rpc).toHaveBeenCalledWith(client, 'get_sales_sheet_sync_status', { p_source_key: salesSourceKey({ spreadsheetId: env.GOOGLE_SALES_SYNC_SPREADSHEET_ID }) });
  });
  it('does not require Google credentials in the web process', async () => {
    rpc.mockResolvedValue({ latestRun: null, lastPublishedRun: null });
    expect(await getSalesSyncStatus(client, { ...env,
      GOOGLE_SALES_SYNC_PRIVATE_KEY: undefined, GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL: undefined,
    })).toMatchObject({ configured: true, reason: 'ready' });
  });
  it.each(['2026-11-03T09:15:00Z', '2026-11-03T09:59:59Z'])('uses one daily slot inside the Sao Paulo retry window %s', async (time) => {
    rpc.mockResolvedValue({ runId: id, leaseToken: lease, replayed: false, result });
    await beginSalesSync(client, identity, { trigger: 'scheduled' }, 'cli', { env, clock: () => new Date(time) });
    expect(rpc).toHaveBeenCalledWith(client, 'begin_sales_sheet_sync', { p_source_key: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_request_key: '2026-11-03@06:15', p_trigger: 'scheduled' });
  });
  it.each(['2026-11-03T09:14:59Z', '2026-11-03T10:00:00Z'])('does not allocate outside scheduled window %s', async (time) => {
    await expect(beginSalesSync(client, identity, { trigger: 'scheduled' }, 'cli', { env, clock: () => new Date(time) })).rejects.toMatchObject({ status: 422 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('requires technical actor and CLI even for manual intentions; flags never override SQL denial', async () => {
    const command = { trigger: 'manual', idempotencyKey: id } as const;
    await expect(beginSalesSync(client, identity, command, 'web', { env })).rejects.toMatchObject({ status: 403 });
    await expect(beginSalesSync(client, { ...identity, id: lease }, command, 'cli', { env })).rejects.toMatchObject({ status: 403 });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockRejectedValue(new Error('database binding denied'));
    await expect(beginSalesSync(client, identity, command, 'cli', { env })).rejects.toThrow('database binding denied');
  });
  it('forwards exact staging/publish/fail contracts under the caller without service_role', async () => {
    rpc.mockResolvedValueOnce({ stagedCount: 0, replayed: true }).mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    await stageSalesSync(client, id, { leaseToken: lease, chunkHash: 'a'.repeat(64), chunkIndex: 0, rows: [] });
    expect(rpc).toHaveBeenLastCalledWith(client, 'stage_sales_sheet_sync', { p_run_id: id, p_lease_token: lease,
      p_chunk_hash: 'a'.repeat(64), p_chunk_index: 0, p_rows: [] });
    await publishSalesSync(client, id, { leaseToken: lease, contentHash: 'a'.repeat(64), expectedRowCount: 1, parserVersion: 1 });
    expect(rpc).toHaveBeenLastCalledWith(client, 'publish_sales_sheet_sync', expect.objectContaining({ p_origin: 'cli', p_parser_version: 1 }));
    await failSalesSync(client, id, { leaseToken: lease, errorCode: 'SOURCE_CHANGED' });
    expect(rpc).toHaveBeenLastCalledWith(client, 'fail_sales_sheet_sync', { p_run_id: id, p_lease_token: lease, p_error_code: 'SOURCE_CHANGED' });
  });
});
