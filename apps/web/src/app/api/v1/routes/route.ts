import { randomUUID } from 'node:crypto';
import { createRouteDraftRequestSchema, routesPath } from '@cirne/contracts';
import { createRouteDraft } from '@/server/routes/service';
import { SupabaseRouteRepository } from '@/server/routes/supabase-repository';
import {
  enforceRouteCookieCsrf,
  logRouteRequest,
  mapRouteRequestError,
  readRouteJson,
  resolveRouteRequest,
  routeErrorResponse,
  routeResponseHeaders,
  RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 201;
  try {
    enforceRouteCookieCsrf(request);
    const { identity, client } = await resolveRouteRequest(request, headers);
    if (!identity.roles.includes('manager') || !identity.capabilities.includes('route.plan_scoped')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const parsed = createRouteDraftRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Rota inválida.', false);
    }
    const result = await createRouteDraft(parsed.data, new SupabaseRouteRepository(client));
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: routesPath, method: 'POST', status, startedAt });
  }
}
