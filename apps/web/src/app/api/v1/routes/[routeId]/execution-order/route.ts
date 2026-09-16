import { randomUUID } from 'node:crypto';
import { reorderRouteExecutionRequestSchema, routeExecutionOrderPath } from '@cirne/contracts';
import { reorderRouteExecution } from '@/server/routes/service';
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

export async function PUT(
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
    const canReorderSelf = identity.roles.includes('seller') &&
      identity.capabilities.includes('route.reorder_self');
    const canReorderScoped = identity.roles.includes('manager') &&
      identity.capabilities.includes('route.reorder_scoped');
    if (!canReorderSelf && !canReorderScoped) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const parsed = reorderRouteExecutionRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Ordem de execução inválida.', false);
    }
    const { routeId } = await context.params;
    const origin = request.headers.has('authorization')
      ? 'cli' as const
      : canReorderSelf ? 'pwa' as const : 'web' as const;
    const result = await reorderRouteExecution(
      routeId,
      parsed.data,
      { requestId, origin },
      new SupabaseRouteRepository(client),
    );
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({
      requestId,
      routeTemplate: routeExecutionOrderPath('{routeId}'),
      method: 'PUT',
      status,
      startedAt,
    });
  }
}
