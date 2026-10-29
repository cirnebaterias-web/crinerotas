import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabasePilotMetricsRepository } from './supabase-repository';

const filters = { from: '2026-10-26', to: '2026-11-01' };
const emptyProjection = {
  generatedAt: '2026-10-28T15:00:00.000Z', lastServerConfirmedAt: null,
  totals: {
    completed: 0, requiredComplete: 0, scrapReported: 0, commercialActionReported: 0,
    syncWithin24h: 0, syncEligible: 0, windowOpen: 0, clockSuspicious: 0,
  },
  records: [], nextCursor: null,
};

function clientResult(result: { data: unknown; error: { message?: string } | null }) {
  const abortSignal = vi.fn().mockResolvedValue(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { client: { schema } as unknown as SupabaseClient, schema, rpc };
}

describe('SupabasePilotMetricsRepository', () => {
  it('calls only the guarded projection RPC with explicit filters', async () => {
    const mock = clientResult({ data: emptyProjection, error: null });
    await expect(new SupabasePilotMetricsRepository(mock.client).get(filters, 'America/Sao_Paulo'))
      .resolves.toEqual(emptyProjection);
    expect(mock.schema).toHaveBeenCalledWith('api');
    expect(mock.rpc).toHaveBeenCalledWith('get_pilot_metrics', {
      p_from: '2026-10-26', p_to: '2026-11-01', p_seller_id: null, p_client_id: null,
      p_cursor: null, p_operational_time_zone: 'America/Sao_Paulo',
    });
  });

  it('preserves known denials and hides unknown database errors', async () => {
    const denied = clientResult({ data: null, error: { message: 'FORBIDDEN' } });
    await expect(new SupabasePilotMetricsRepository(denied.client).get(filters, 'UTC'))
      .rejects.toMatchObject({ code: 'FORBIDDEN', recoverable: false });
    const unknown = clientResult({ data: null, error: { message: 'private relation detail' } });
    await expect(new SupabasePilotMetricsRepository(unknown.client).get(filters, 'UTC'))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
