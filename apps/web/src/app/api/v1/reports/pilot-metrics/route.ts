import { pilotMetricsPath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { randomUUID } from 'node:crypto';
import { getPilotMetrics, normalizePilotMetricsFilters } from '@/server/pilot-metrics/service';
import { SupabasePilotMetricsRepository } from '@/server/pilot-metrics/supabase-repository';
import {
  logRouteRequest, mapRouteRequestError, resolveRouteRequest, routeErrorResponse,
  routeResponseHeaders, RouteRequestError,
} from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const allowedParameters = new Set(['from', 'to', 'sellerId', 'clientId', 'cursor']);

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = routeResponseHeaders(requestId);
  let status = 200;
  try {
    const url = new URL(request.url);
    const supplied = [...url.searchParams.keys()];
    if (supplied.some((key) => !allowedParameters.has(key)) || new Set(supplied).size !== supplied.length) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Filtro das métricas do piloto inválido ou repetido.', false);
    }
    const { identity, client } = await resolveRouteRequest(request, headers);
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const filters = normalizePilotMetricsFilters({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      sellerId: url.searchParams.get('sellerId') ?? undefined,
      clientId: url.searchParams.get('clientId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    }, timeZone);
    return Response.json(await getPilotMetrics(
      identity, filters, timeZone, new SupabasePilotMetricsRepository(client),
    ), { headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: pilotMetricsPath, method: 'GET', status, startedAt });
  }
}
