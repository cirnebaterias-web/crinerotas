import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { clientSheetHeaders, type MeResponse } from '@cirne/contracts';
import { clientImportRpc } from '../client-imports/http';
import { RouteRequestError } from '../routes/http';
import { getClientSheetSyncStatus, synchronizeClientSheet } from './service';

vi.mock('../client-imports/http', () => ({ clientImportRpc: vi.fn() }));
const rpc = vi.mocked(clientImportRpc);
const client = {} as SupabaseClient;
const id = '31300000-0000-4000-8000-000000000001';
const lease = '31300000-0000-4000-8000-000000000002';
const identity: MeResponse = { id, displayName: 'Gestor Sintético', roles: ['manager'],
  capabilities: ['clients.import'], scopeIds: [], status: 'active' };
const env = { GOOGLE_CLIENT_SYNC_ENABLED: 'true',
  GOOGLE_CLIENT_SYNC_SPREADSHEET_ID: 'synthetic_spreadsheet_id_123456',
  GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL: 'test@synthetic.iam.gserviceaccount.com',
  GOOGLE_CLIENT_SYNC_PRIVATE_KEY: 'synthetic-placeholder-not-a-real-key'.repeat(5),
  GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON: JSON.stringify({ TESTE: 'seller@example.invalid' }),
  GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED: 'true', GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID: id };
const running = { id, sourceKey: 'a'.repeat(64), status: 'running', trigger: 'manual',
  startedAt: '2026-11-03T09:00:00Z', completedAt: null, acceptedCount: 0,
  pendingCount: 0, ignoredCount: 0, issues: [], batchId: null, errorCode: null };
const completed = { ...running, status: 'completed', completedAt: '2026-11-03T09:00:01Z' };
const command = { trigger: 'manual', idempotencyKey: id } as const;
const row = (reference: string, portfolio: string, status: string) =>
  ['Cliente Sintético', reference, '', portfolio, status, '', '', '', '', 'Rua Sintética, 10'];

beforeEach(() => { rpc.mockReset(); });
describe('client sheet orchestration', () => {
  it('reports disabled configuration without querying or exposing configuration', async () => {
    const state = await getClientSheetSyncStatus(client, {});
    expect(state).toMatchObject({ configured: false, reason: 'disabled', latest: null });
    expect(rpc).not.toHaveBeenCalled();
    await expect(synchronizeClientSheet(client, identity, command, 'web', { env: {} })).rejects.toMatchObject({ status: 503 });
  });
  it('returns the owner-scoped database state without source ID or credentials', async () => {
    rpc.mockResolvedValue(completed);
    const state = await getClientSheetSyncStatus(client, env);
    expect(state.latest?.status).toBe('completed');
    expect(JSON.stringify(state)).not.toContain(env.GOOGLE_CLIENT_SYNC_SPREADSHEET_ID);
    expect(rpc).toHaveBeenCalledWith(client, 'get_client_sheet_sync_status', { p_source_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('replays the canonical result without reading Google or importing twice', async () => {
    rpc.mockResolvedValue({ runId: id, leaseToken: null, replayed: true, result: completed });
    const readSheet = vi.fn();
    expect(await synchronizeClientSheet(client, identity, command, 'web', { env, readSheet })).toEqual(completed);
    expect(readSheet).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('sends normalized rows, excluded count and actionable pending issues to the atomic finish', async () => {
    rpc.mockResolvedValueOnce({ runId: id, leaseToken: lease, replayed: false, result: running })
      .mockResolvedValueOnce([]).mockResolvedValueOnce(completed);
    const readSheet = vi.fn().mockResolvedValue([[...clientSheetHeaders],
      row('01234567000199', 'TESTE', 'ATIVO'), row('01234567000299', 'OUTROS', ''),
      row('01234567000399', 'TESTE', '')]);
    await synchronizeClientSheet(client, identity, command, 'web', { env, readSheet });
    expect(rpc).toHaveBeenLastCalledWith(client, 'finish_client_sheet_sync', expect.objectContaining({
      p_run_id: id, p_lease_token: lease, p_ignored_count: 1, p_origin: 'web',
      p_command: expect.objectContaining({ acceptedCount: 1, rejectedCount: 1,
        issues: [expect.objectContaining({ rowNumber: 4, code: 'STATUS_PENDING_REVIEW' })] }),
    }));
  });
  it('keeps a seller denied by database validation pending without importing that row', async () => {
    rpc.mockResolvedValueOnce({ runId: id, leaseToken: lease, replayed: false, result: running })
      .mockResolvedValueOnce(['seller@example.invalid']).mockResolvedValueOnce(completed);
    await synchronizeClientSheet(client, identity, command, 'web', { env,
      readSheet: vi.fn().mockResolvedValue([[...clientSheetHeaders], row('01234567000199', 'TESTE', 'ATIVO')]) });
    expect(rpc).toHaveBeenLastCalledWith(client, 'finish_client_sheet_sync', expect.objectContaining({
      p_command: expect.objectContaining({ acceptedCount: 0, rejectedCount: 1, rows: [],
        issues: [expect.objectContaining({ code: 'SELLER_NOT_FOUND' })] }),
    }));
  });
  it('persists only a stable error code and preserves the original failure if fail RPC is offline', async () => {
    rpc.mockResolvedValueOnce({ runId: id, leaseToken: lease, replayed: false, result: running })
      .mockRejectedValueOnce(new Error('database offline'));
    const error = new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Google indisponível.', true);
    await expect(synchronizeClientSheet(client, identity, command, 'web', { env,
      readSheet: vi.fn().mockRejectedValue(error) })).rejects.toBe(error);
    expect(rpc).toHaveBeenLastCalledWith(client, 'fail_client_sheet_sync', {
      p_run_id: id, p_lease_token: lease, p_error_code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
  it.each(['web', 'cli'] as const)('rejects unauthorized scheduled caller from %s', async (origin) => {
    await expect(synchronizeClientSheet(client, { ...identity, id: lease }, { trigger: 'scheduled' }, origin,
      { env })).rejects.toMatchObject({ status: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects browser scheduling even for the configured operator and rejects wrong time', async () => {
    await expect(synchronizeClientSheet(client, identity, { trigger: 'scheduled' }, 'web', { env })).rejects.toMatchObject({ status: 403 });
    await expect(synchronizeClientSheet(client, identity, { trigger: 'scheduled' }, 'cli', {
      env, clock: () => new Date('2026-11-03T12:00:00Z'),
    })).rejects.toMatchObject({ status: 422 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['2026-11-03T09:00:00Z', '2026-11-03T09:59:00Z'])('derives the same scheduled key throughout the retry window: %s', async (time) => {
    rpc.mockResolvedValue({ runId: id, leaseToken: null, replayed: true, result: completed });
    await synchronizeClientSheet(client, identity, { trigger: 'scheduled' }, 'cli', { env, clock: () => new Date(time) });
    expect(rpc).toHaveBeenCalledWith(client, 'begin_client_sheet_sync', {
      p_source_key: expect.any(String), p_request_key: '2026-11-03@06:00', p_trigger: 'scheduled',
    });
  });
  it('never reads Google after a busy/denied begin', async () => {
    const readSheet = vi.fn();
    rpc.mockRejectedValue(new RouteRequestError(409, 'VERSION_CONFLICT', 'Em andamento.', true));
    await expect(synchronizeClientSheet(client, identity, command, 'web', { env, readSheet })).rejects.toMatchObject({ status: 409 });
    expect(readSheet).not.toHaveBeenCalled();
  });
  it('honors database scheduler denial even when the BFF configuration permits the actor', async () => {
    const readSheet = vi.fn();
    rpc.mockRejectedValue(new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false));
    await expect(synchronizeClientSheet(client, identity, { trigger: 'scheduled' }, 'cli', {
      env, readSheet, clock: () => new Date('2026-11-03T09:00:00Z'),
    })).rejects.toMatchObject({ status: 403 });
    expect(readSheet).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
