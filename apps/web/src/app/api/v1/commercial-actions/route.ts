import { randomUUID } from 'node:crypto';
import {
  commercialActionListSchema,
  saveCommercialActionRequestSchema,
} from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import {
  currentServiceDate, enforceRouteCookieCsrf, mapRouteRequestError, readRouteJson, resolveRouteRequest,
  routeErrorResponse, routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function mapAction(row: Record<string, unknown>) {
  return {
    id: row.id, title: row.title, description: row.description,
    validFrom: row.valid_from, validUntil: row.valid_until,
    ...(row.banner_url ? { bannerUrl: row.banner_url } : {}), active: row.active,
  };
}

export async function GET(request: Request) {
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  try {
    const { identity, client } = await resolveRouteRequest(request, headers);
    let query = client.schema('api').from('commercial_actions').select('*')
      .order('valid_from', { ascending: false }).limit(100);
    if (!identity.roles.includes('manager')) {
      const today = currentServiceDate(readServerConfig(process.env).OPERATIONAL_TIME_ZONE);
      query = query.eq('active', true).lte('valid_from', today).gte('valid_until', today);
    }
    const { data, error } = await query;
    if (error) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Ações temporariamente indisponíveis.', true);
    return Response.json(commercialActionListSchema.parse({
      schemaVersion: 1, actions: (data ?? []).map((row) => mapAction(row as Record<string, unknown>)),
    }), { headers });
  } catch (error) {
    return routeErrorResponse(mapRouteRequestError(error), requestId, headers);
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  try {
    enforceRouteCookieCsrf(request);
    const { identity, client } = await resolveRouteRequest(request, headers);
    if (!identity.roles.includes('manager')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const parsed = saveCommercialActionRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados da ação.', false);
    const value = parsed.data;
    const { data, error } = await client.schema('api').from('commercial_actions').insert({
      title: value.title, description: value.description, valid_from: value.validFrom,
      valid_until: value.validUntil, banner_url: value.bannerUrl ?? null, active: value.active,
      created_by: identity.id, updated_by: identity.id,
    }).select('*').single();
    if (error || !data) throw new RouteRequestError(503, 'DEPENDENCY_UNAVAILABLE', 'Não foi possível cadastrar a ação.', true);
    return Response.json(mapAction(data as Record<string, unknown>), { status: 201, headers });
  } catch (error) {
    return routeErrorResponse(mapRouteRequestError(error), requestId, headers);
  }
}
