import { managementDayPath, managementServiceDateSchema } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { randomUUID } from 'node:crypto';
import { getManagementDay, managementCurrentDate } from '@/server/management-day/service';
import { SupabaseManagementDayRepository } from '@/server/management-day/supabase-repository';
import {
  logRouteRequest,
  mapRouteRequestError,
  resolveRouteRequest,
  routeErrorResponse,
  routeResponseHeaders,
  RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    const url = new URL(request.url);
    const supplied = url.searchParams.get('serviceDate');
    if ([...url.searchParams.keys()].some((key) => key !== 'serviceDate') ||
        (supplied !== null && !managementServiceDateSchema.safeParse(supplied).success)) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Use serviceDate no formato YYYY-MM-DD.', false);
    }
    const { identity, client } = await resolveRouteRequest(request, headers);
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const serviceDate = supplied ?? managementCurrentDate(timeZone);
    const result = await getManagementDay(
      identity, serviceDate, timeZone, new SupabaseManagementDayRepository(client),
    );
    return Response.json(result, { headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: managementDayPath, method: 'GET', status, startedAt });
  }
}
