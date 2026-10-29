import { fieldIntelligenceResponseSchema, type RouteErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { FieldIntelligenceRepository } from './service';

const knownDatabaseCodes = new Set<RouteErrorCode>(['FORBIDDEN', 'VALIDATION_FAILED']);

export class SupabaseFieldIntelligenceRepository implements FieldIntelligenceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async get(filters: Parameters<FieldIntelligenceRepository['get']>[0], operationalTimeZone: string) {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_field_intelligence', {
        p_section: filters.section,
        p_from: filters.from,
        p_to: filters.to,
        p_seller_id: filters.sellerId ?? null,
        p_client_id: filters.clientId ?? null,
        p_competitor_id: filters.competitorId ?? null,
        p_action_type: filters.actionType ?? null,
        p_cursor: filters.cursor ?? null,
        p_operational_time_zone: operationalTimeZone,
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
    const parsed = fieldIntelligenceResponseSchema.safeParse(data);
    if (!parsed.success || parsed.data.section !== filters.section) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    return parsed.data;
  }
}
