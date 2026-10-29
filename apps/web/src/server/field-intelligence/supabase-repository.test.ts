import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseFieldIntelligenceRepository } from './supabase-repository';

const filters = { section: 'stock' as const, from: '2026-10-26', to: '2026-11-01' };
const emptyStock = {
  schemaVersion: 1, section: 'stock', filters, generatedAt: '2026-10-28T12:00:00.000Z',
  lastConfirmedAt: null, nextCursor: null,
  serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.',
  indicators: { records: 0, heliarQuantity: 0, mouraQuantity: 0, ownLineQuantity: 0, competitorLineQuantity: 0 },
  records: [],
};

function clientResult(result: { data: unknown; error: { message?: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { client: { schema } as unknown as SupabaseClient, schema, rpc, abortSignal };
}

describe('SupabaseFieldIntelligenceRepository', () => {
  it('calls only the guarded RPC with explicit null filters', async () => {
    const mock = clientResult({ data: emptyStock, error: null });
    const result = await new SupabaseFieldIntelligenceRepository(mock.client).get(filters, 'America/Sao_Paulo');
    expect(result).toEqual(emptyStock);
    expect(mock.schema).toHaveBeenCalledWith('api');
    expect(mock.rpc).toHaveBeenCalledWith('get_field_intelligence', {
      p_section: 'stock', p_from: '2026-10-26', p_to: '2026-11-01', p_seller_id: null,
      p_client_id: null, p_competitor_id: null, p_action_type: null, p_cursor: null,
      p_operational_time_zone: 'America/Sao_Paulo',
    });
  });

  it('maps a database authorization rejection without exposing internals', async () => {
    const mock = clientResult({ data: null, error: { message: 'FORBIDDEN' } });
    await expect(new SupabaseFieldIntelligenceRepository(mock.client).get(filters, 'America/Sao_Paulo'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', recoverable: false });
  });

  it('maps unknown database failures to a recoverable dependency error', async () => {
    const mock = clientResult({ data: null, error: { message: 'relation detail that must stay private' } });
    await expect(new SupabaseFieldIntelligenceRepository(mock.client).get(filters, 'America/Sao_Paulo'))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
