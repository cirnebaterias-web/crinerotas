import { randomUUID } from 'node:crypto';
import { routePath } from '@cirne/contracts';
import { getRoute } from '@/server/routes/service';
import { SupabaseRouteRepository } from '@/server/routes/supabase-repository';
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

export async function GET(
  request: Request,
  context: { params: Promise<{ routeId: string }> },
) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    const { identity, client } = await resolveRouteRequest(request, headers);
    const canRead = identity.capabilities.includes('route.read_self') ||
      identity.capabilities.includes('route.read_scoped');
    if (!canRead) throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    const { routeId } = await context.params;
    const result = await getRoute(routeId, new SupabaseRouteRepository(client));
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: routePath('{routeId}'), method: 'GET', status, startedAt });
  }
}
