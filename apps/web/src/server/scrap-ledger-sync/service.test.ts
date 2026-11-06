import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { createGoogleScrapLedgerReader } from '../../../../cli/src/scrap-ledger-google';
import { synchronizeScrapLedger } from './service';

vi.mock('@cirne/config/scrap-ledger-sync', () => ({
  readScrapLedgerSheetConfig: vi.fn(() => ({ configured: true, config: {
    enabled: true, spreadsheetId: 'synthetic-sheet', publicRead: true,
    scheduleEnabled: false, schedulerActorId: null, email: null, privateKey: null,
  } })),
  readScrapLedgerSyncServerConfig: vi.fn(),
}));
vi.mock('../../../../cli/src/scrap-ledger-google', () => ({ createGoogleScrapLedgerReader: vi.fn() }));

const actorId = '11111111-1111-4111-8111-111111111111';
const run = { id: '22222222-2222-4222-8222-222222222222', status: 'collecting', trigger: 'manual',
  startedAt: '2026-11-05T12:00:00Z', completedAt: null, entryCount: 0, balanceCount: 0, errorCode: null };
const identity = { id: actorId, displayName: 'Gestor', status: 'active', roles: ['manager'],
  capabilities: ['scrap_ledger.sync'], scopeIds: [] } as MeResponse;

describe('scrap ledger synchronization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists a failed attempt when Google acquisition fails after begin', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = { schema: () => ({ rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: async () => {
        calls.push({ name, args });
        return { data: name === 'begin_scrap_ledger_sync' ? run : { ...run, status: 'failed',
          completedAt: '2026-11-05T12:00:01Z', errorCode: 'SYNC_FAILED' }, error: null };
      },
    }) }) } as never;
    vi.mocked(createGoogleScrapLedgerReader).mockRejectedValue(new Error('Google indisponível'));

    await expect(synchronizeScrapLedger(client, identity, { trigger: 'manual', idempotencyKey: actorId }, 'web'))
      .rejects.toThrow('Google indisponível');

    expect(calls.map(({ name }) => name)).toEqual(['begin_scrap_ledger_sync', 'fail_scrap_ledger_sync']);
    expect(calls[1]?.args).toMatchObject({ p_run_id: run.id, p_error_code: 'SYNC_FAILED' });
  });
});
