import { randomUUID } from 'node:crypto';
import { changeRouteCompositionRequestSchema, routePath, routeDraftSchema } from '@cirne/contracts';
import { changeRouteComposition, getRoute } from '@/server/routes/service';
import { SupabaseRouteRepository } from '@/server/routes/supabase-repository';
import {
  logRouteRequest,
  enforceRouteCookieCsrf,
  mapRouteRequestError,
  resolveRouteRequest,
  routeErrorResponse,
  routeResponseHeaders,
  RouteRequestError,
  readRouteJson,
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

export async function PATCH(
  request: Request,
  context: { params: Promise<{ routeId: string }> },
) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    enforceRouteCookieCsrf(request);
    const { identity, client } = await resolveRouteRequest(request, headers);
    if (!identity.roles.includes('manager') || !identity.capabilities.includes('route.plan_scoped')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || !routeDraftSchema.shape.routeId.safeParse(idempotencyKey).success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Idempotency-Key UUID obrigatória.', false);
    }
    const parsed = changeRouteCompositionRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Composição de rota inválida.', false);
    }
    const { routeId } = await context.params;
    const result = await changeRouteComposition(
      routeId,
      parsed.data,
      { idempotencyKey, origin: request.headers.has('authorization') ? 'cli' : 'web' },
      new SupabaseRouteRepository(client),
    );
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: routePath('{routeId}'), method: 'PATCH', status, startedAt });
  }
}
