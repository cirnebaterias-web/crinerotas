import { managementMapPath, managementMapQuerySchema } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { randomUUID } from 'node:crypto';
import { getManagementMap } from '@/server/management-map/service';
import { SupabaseManagementMapRepository } from '@/server/management-map/supabase-repository';
import { managementCurrentDate } from '@/server/management-day/service';
import {
  logRouteRequest, mapRouteRequestError, resolveRouteRequest, routeErrorResponse,
  routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    const parameters = new URL(request.url).searchParams;
    if ([...parameters.keys()].some((key) => parameters.getAll(key).length !== 1)) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Filtro do mapa repetido.', false);
    }
    const parsed = managementMapQuerySchema.safeParse(Object.fromEntries(parameters.entries()));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Use serviceDate no formato YYYY-MM-DD.', false);
    }
    const { identity, client } = await resolveRouteRequest(request, headers);
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const serviceDate = parsed.data.serviceDate ?? managementCurrentDate(timeZone);
    return Response.json(await getManagementMap(
      identity, serviceDate, new SupabaseManagementMapRepository(client),
    ), { headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: managementMapPath, method: 'GET', status, startedAt });
  }
}
