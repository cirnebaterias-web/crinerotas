import { managementMapResponseSchema, type RouteErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { ManagementMapRepository } from './service';

const knownDatabaseCodes = new Set<RouteErrorCode>(['FORBIDDEN', 'VALIDATION_FAILED']);

export class SupabaseManagementMapRepository implements ManagementMapRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getForDate(serviceDate: string) {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_management_route_map', {
        p_service_date: serviceDate,
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    const { data, error } = result;
    if (error) {
      const code = knownDatabaseCodes.has(error.message as RouteErrorCode)
        ? error.message as RouteErrorCode : 'DEPENDENCY_UNAVAILABLE';
      throw new RouteServiceFailure(code, publicRouteMessage(code), code === 'DEPENDENCY_UNAVAILABLE');
    }
    const parsed = managementMapResponseSchema.safeParse(data);
    if (!parsed.success || parsed.data.serviceDate !== serviceDate) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    return parsed.data;
  }
}
