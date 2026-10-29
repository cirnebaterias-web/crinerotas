import { scrapAgendaPath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { randomUUID } from 'node:crypto';
import { getScrapAgenda, normalizeScrapAgendaFilters } from '@/server/scrap-agenda/service';
import { SupabaseScrapAgendaRepository } from '@/server/scrap-agenda/supabase-repository';
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

const allowedParameters = new Set(['from', 'to', 'status', 'period', 'sellerId', 'clientId', 'cursor']);

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
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Filtro da agenda inválido ou repetido.', false);
    }
    const { identity, client } = await resolveRouteRequest(request, headers);
    const timeZone = readServerConfig(process.env).OPERATIONAL_TIME_ZONE;
    const filters = normalizeScrapAgendaFilters({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      period: url.searchParams.get('period') ?? undefined,
      sellerId: url.searchParams.get('sellerId') ?? undefined,
      clientId: url.searchParams.get('clientId') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? undefined,
    }, timeZone);
    const result = await getScrapAgenda(identity, filters, new SupabaseScrapAgendaRepository(client));
    return Response.json(result, { headers });
  } catch (error) {
    const publicError = mapRouteRequestError(error);
    status = publicError.status;
    return routeErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate: scrapAgendaPath, method: 'GET', status, startedAt });
  }
}
