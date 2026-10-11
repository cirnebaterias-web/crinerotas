import { randomUUID } from 'node:crypto';
import { saveCommercialActionRequestSchema } from '@cirne/contracts';
import {
  enforceRouteCookieCsrf, mapRouteRequestError, readRouteJson, resolveRouteRequest,
  routeErrorResponse, routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ actionId: string }> }) {
  const requestId = randomUUID(); const headers = routeResponseHeaders(requestId);
  try {
    enforceRouteCookieCsrf(request);
    const { identity, client } = await resolveRouteRequest(request, headers);
    if (!identity.roles.includes('manager')) throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    const { actionId } = await context.params;
    const parsedId = /^[0-9a-f-]{36}$/iu.test(actionId);
    const parsed = saveCommercialActionRequestSchema.safeParse(await readRouteJson(request));
    if (!parsedId || !parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados da ação.', false);
    const value = parsed.data;
    const { data, error } = await client.schema('api').from('commercial_actions').update({
      title: value.title, description: value.description, valid_from: value.validFrom,
      valid_until: value.validUntil, banner_url: value.bannerUrl ?? null,
      active: value.active, updated_by: identity.id,
    }).eq('id', actionId).select('*').single();
    if (error || !data) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Não foi possível atualizar a ação.', true);
    return Response.json({
      id: data.id, title: data.title, description: data.description,
      validFrom: data.valid_from, validUntil: data.valid_until,
      ...(data.banner_url ? { bannerUrl: data.banner_url } : {}), active: data.active,
    }, { headers });
  } catch (error) { return routeErrorResponse(mapRouteRequestError(error), requestId, headers); }
}
