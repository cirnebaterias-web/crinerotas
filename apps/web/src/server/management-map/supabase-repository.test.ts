import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseManagementMapRepository } from './supabase-repository';

const empty = {
  schemaVersion: 1, serviceDate: '2026-10-29', generatedAt: '2026-10-29T12:00:00.000Z',
  availability: 'empty', totals: { routes: 0, stops: 0, positioned: 0, unpositioned: 0 }, routes: [],
  serverVisibilityNote: 'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.',
};

function repositoryResult(result: { data: unknown; error: { message?: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { repository: new SupabaseManagementMapRepository({ schema } as unknown as SupabaseClient), rpc };
}

describe('Supabase management map repository', () => {
  it('uses only the service date in the narrow RPC', async () => {
    const { repository, rpc } = repositoryResult({ data: empty, error: null });
    await expect(repository.getForDate('2026-10-29')).resolves.toEqual(empty);
    expect(rpc).toHaveBeenCalledWith('get_management_route_map', { p_service_date: '2026-10-29' });
  });

  it('preserves authorization failures and sanitizes unknown database details', async () => {
    await expect(repositoryResult({ data: null, error: { message: 'FORBIDDEN' } }).repository
      .getForDate('2026-10-29')).rejects.toMatchObject({ code: 'FORBIDDEN', recoverable: false });
    await expect(repositoryResult({ data: null, error: { message: 'relation private.secret failed' } }).repository
      .getForDate('2026-10-29')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });

  it('rejects malformed or mismatched projections', async () => {
    await expect(repositoryResult({ data: { ...empty, serviceDate: '2026-10-30' }, error: null }).repository
      .getForDate('2026-10-29')).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
