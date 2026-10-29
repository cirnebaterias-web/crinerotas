import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseScrapAgendaRepository } from './supabase-repository';

const filters = { from: '2026-10-26', to: '2026-11-01', status: 'pending' as const };
const emptyAgenda = {
  schemaVersion: 1, filters, generatedAt: '2026-10-28T12:00:00.000Z',
  lastServerConfirmedAt: null, indicators: { records: 0, scheduledKg: '0' }, records: [], nextCursor: null,
  serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
};

function clientResult(result: { data: unknown; error: { message?: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { client: { schema } as unknown as SupabaseClient, schema, rpc, abortSignal };
}

describe('SupabaseScrapAgendaRepository', () => {
  it('calls only the guarded RPC with explicit null filters', async () => {
    const mock = clientResult({ data: emptyAgenda, error: null });
    await expect(new SupabaseScrapAgendaRepository(mock.client).get(filters)).resolves.toEqual(emptyAgenda);
    expect(mock.schema).toHaveBeenCalledWith('api');
    expect(mock.rpc).toHaveBeenCalledWith('get_scrap_agenda', {
      p_from: '2026-10-26', p_to: '2026-11-01', p_status: 'pending', p_period: null,
      p_seller_id: null, p_client_id: null, p_cursor: null,
    });
  });

  it('maps authorization and hides unknown database failures', async () => {
    const denied = clientResult({ data: null, error: { message: 'FORBIDDEN' } });
    await expect(new SupabaseScrapAgendaRepository(denied.client).get(filters))
      .rejects.toMatchObject({ code: 'FORBIDDEN', recoverable: false });
    const internal = clientResult({ data: null, error: { message: 'relation private_detail' } });
    await expect(new SupabaseScrapAgendaRepository(internal.client).get(filters))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
