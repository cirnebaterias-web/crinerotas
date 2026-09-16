import { randomUUID } from 'node:crypto';
import { myTodayRoutePath } from '@cirne/contracts';
import { getMyRouteForDate } from '@/server/routes/service';
import { SupabaseRouteRepository } from '@/server/routes/supabase-repository';
import { readServerConfig } from '@cirne/config/server';
import {
  currentServiceDate,
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
    const { identity, client } = await resolveRouteRequest(request, headers);
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('route.read_self')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const result = await getMyRouteForDate(currentServiceDate(timeZone), new SupabaseRouteRepository(client));
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: myTodayRoutePath, method: 'GET', status, startedAt });
  }
}
