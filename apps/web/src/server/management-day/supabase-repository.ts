import { managementDayAttemptProjectionSchema, managementDayResponseSchema, type RouteErrorCode } from '@cirne/contracts';
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
    if(parsed.data.routes.length===0)return parsed.data;
    let attemptsResult:{data:unknown;error:{message?:string}|null};
    try{attemptsResult=await this.client.schema('api').rpc('list_management_day_route_stop_attempts',{p_service_date:serviceDate}).abortSignal(AbortSignal.timeout(10_000));}
    catch{throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE',publicRouteMessage('DEPENDENCY_UNAVAILABLE'),true);}
    if(attemptsResult.error)throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE',publicRouteMessage('DEPENDENCY_UNAVAILABLE'),true);
    const attempts=managementDayAttemptProjectionSchema.safeParse(attemptsResult.data);if(!attempts.success)throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE',publicRouteMessage('DEPENDENCY_UNAVAILABLE'),true);
    const byStop=new Map(attempts.data.attempts.map(item=>[item.routeVersionStopId,item.attempt]));
    return managementDayResponseSchema.parse({...parsed.data,routes:parsed.data.routes.map(route=>'stops'in route?{...route,stops:route.stops.map(stop=>({...stop,nonVisitAttempt:byStop.get(stop.routeVersionStopId)??null}))}:route)});
  }
}
