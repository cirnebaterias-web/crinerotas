import { managementDayResponseSchema, type RouteErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { ManagementDayRepository } from './service';

const knownDatabaseCodes = new Set<RouteErrorCode>(['FORBIDDEN', 'VALIDATION_FAILED']);

export class SupabaseManagementDayRepository implements ManagementDayRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getForDate(serviceDate: string, operationalTimeZone: string) {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_management_day', {
        p_service_date: serviceDate,
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
    const parsed = managementDayResponseSchema.safeParse(data);
    if (!parsed.success || parsed.data.serviceDate !== serviceDate) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
    }
    return parsed.data;
  }
}
