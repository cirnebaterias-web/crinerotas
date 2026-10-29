import { scrapAgendaResponseSchema, type RouteErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { ScrapAgendaRepository } from './service';

const knownDatabaseCodes = new Set<RouteErrorCode>(['FORBIDDEN', 'VALIDATION_FAILED']);

export class SupabaseScrapAgendaRepository implements ScrapAgendaRepository {
  constructor(private readonly client: SupabaseClient) {}

  async get(filters: Parameters<ScrapAgendaRepository['get']>[0]) {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_scrap_agenda', {
        p_from: filters.from,
        p_to: filters.to,
        p_status: filters.status,
        p_period: filters.period ?? null,
        p_seller_id: filters.sellerId ?? null,
        p_client_id: filters.clientId ?? null,
        p_cursor: filters.cursor ?? null,
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    const { data, error } = result;
    if (error) {
      const code = knownDatabaseCodes.has(error.message as RouteErrorCode)
        ? error.message as RouteErrorCode
        : 'DEPENDENCY_UNAVAILABLE';
      throw new RouteServiceFailure(code, publicRouteMessage(code), code === 'DEPENDENCY_UNAVAILABLE');
    }
    const parsed = scrapAgendaResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    return parsed.data;
  }
}
