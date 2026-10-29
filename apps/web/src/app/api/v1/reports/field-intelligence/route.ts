import { fieldIntelligencePath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { randomUUID } from 'node:crypto';
import {
  getFieldIntelligence,
  normalizeFieldIntelligenceFilters,
} from '@/server/field-intelligence/service';
import { SupabaseFieldIntelligenceRepository } from '@/server/field-intelligence/supabase-repository';
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

const allowedParameters = new Set([
  'section', 'from', 'to', 'sellerId', 'clientId', 'competitorId', 'actionType', 'cursor',
]);

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    const url = new URL(request.url);
    const suppliedParameters = [...url.searchParams.keys()];
    if (suppliedParameters.some((key) => !allowedParameters.has(key)) ||
        new Set(suppliedParameters).size !== suppliedParameters.length) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Filtro de inteligência inválido ou repetido.', false);
    }
    const { identity, client } = await resolveRouteRequest(request, headers);
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const filters = normalizeFieldIntelligenceFilters({
      section: url.searchParams.get('section') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      sellerId: url.searchParams.get('sellerId') ?? undefined,
      clientId: url.searchParams.get('clientId') ?? undefined,
      competitorId: url.searchParams.get('competitorId') ?? undefined,
      actionType: url.searchParams.get('actionType') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    }, timeZone);
    const result = await getFieldIntelligence(
      identity, filters, timeZone, new SupabaseFieldIntelligenceRepository(client),
    );
    return Response.json(result, { headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: fieldIntelligencePath, method: 'GET', status, startedAt });
  }
}
