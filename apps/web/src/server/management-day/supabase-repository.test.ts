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

  it('merges the authorized non-visit attempt projection into its route stop', async () => {
    const stopId = '10000000-0000-4000-8000-000000000010';
    const day = { ...empty, schemaVersion: 2, availability: 'available',
      totals: { planned: 1, pending: 0, inVisit: 0, completed: 0, notVisited: 1 }, routes: [{
        routeId: '10000000-0000-4000-8000-000000000011', routeVersionId: '10000000-0000-4000-8000-000000000012', versionNumber: 1,
        seller: { id: '10000000-0000-4000-8000-000000000013', displayName: 'Vendedor' }, counts: { planned: 1, pending: 0, inVisit: 0, completed: 0, notVisited: 1 },
        sync: empty.sync, nonVisits: [{ routeVersionStopId: stopId,
          clientId: '10000000-0000-4000-8000-000000000014', clientName: 'Cliente',
          reasonId: '10000000-0000-4000-8000-000000000015', updatedAt: '2026-10-20T12:00:00.000Z' }],
        historicalExecutions: [], syncIssues: [], visits: [], lastKnownUpdateAt: '2026-10-20T12:00:00.000Z',
        stops: [{ routeVersionStopId: stopId, plannedOrder: 1, executionOrder: 1, priority: 0,
          client: { id: '10000000-0000-4000-8000-000000000014', name: 'Cliente' }, status: 'not_visited',
          nonVisitReason: { id: '10000000-0000-4000-8000-000000000015', label: 'Fechado' },
          lastKnownUpdateAt: '2026-10-20T12:00:00.000Z', visits: [] }],
      }] };
    const results = [{ data: day, error: null }, { data: { schemaVersion: 1, attempts: [{ routeVersionStopId: stopId, attempt: {
      attemptId: '10000000-0000-4000-8000-000000000016', observation: 'Retornar amanhã', recordedAt: '2026-10-20T12:00:00.000Z',
      capturedAt: '2026-10-20T11:59:00.000Z', latitude: -5.8, longitude: -35.2, accuracyM: 12,
      attachmentId: '10000000-0000-4000-8000-000000000017',
    } }] }, error: null }];
    const rpc = vi.fn().mockImplementation(() => ({ abortSignal: vi.fn().mockResolvedValue(results.shift()) }));
    const repository = new SupabaseManagementDayRepository({ schema: vi.fn().mockReturnValue({ rpc }) } as unknown as SupabaseClient);
    const result = await repository.getForDate('2026-10-20', 'America/Recife');
    expect(result.schemaVersion).toBe(2);
    if (result.schemaVersion !== 2) throw new Error('Expected management day schema v2.');
    expect(result.routes[0]?.stops[0]?.nonVisitAttempt).toMatchObject({ observation: 'Retornar amanhã', accuracyM: 12 });
    expect(rpc).toHaveBeenNthCalledWith(2, 'list_management_day_route_stop_attempts', { p_service_date: '2026-10-20' });
  });
});
