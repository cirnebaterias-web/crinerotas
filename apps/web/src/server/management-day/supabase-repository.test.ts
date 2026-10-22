import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseManagementDayRepository } from './supabase-repository';

const empty = {
  schemaVersion: 1, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:00:00.000Z',
  lastKnownUpdateAt: null, availability: 'empty',
  totals: { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 },
  sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null }, routes: [],
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
};

function repositoryResult(result: { data: unknown; error: { message?: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { repository: new SupabaseManagementDayRepository({ schema } as unknown as SupabaseClient), rpc };
}

describe('Supabase management day repository', () => {
  it('uses only the date and operational time zone in the narrow RPC', async () => {
    const { repository, rpc } = repositoryResult({ data: empty, error: null });
    await expect(repository.getForDate('2026-10-20', 'America/Recife')).resolves.toEqual(empty);
    expect(rpc).toHaveBeenCalledWith('get_management_day', {
      p_service_date: '2026-10-20', p_operational_time_zone: 'America/Recife',
    });
  });

  it('preserves database authorization failures and sanitizes unknown failures', async () => {
    const forbidden = repositoryResult({ data: null, error: { message: 'FORBIDDEN' } }).repository;
    await expect(forbidden.getForDate('2026-10-20', 'America/Recife'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', recoverable: false });
    const unknown = repositoryResult({ data: null, error: { message: 'relation private.secret failed' } }).repository;
    await expect(unknown.getForDate('2026-10-20', 'America/Recife'))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
