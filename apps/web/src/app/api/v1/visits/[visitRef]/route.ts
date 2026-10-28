import { randomUUID } from 'node:crypto';
import { visitDetailPath } from '@cirne/contracts';
import { logRouteRequest } from '@/server/routes/http';
import {
  mapVisitRequestError, resolveVisitRequest, VisitRequestError,
  visitErrorResponse, visitResponseHeaders,
} from '@/server/visits/http';
import { getVisitDetail, VisitServiceFailure } from '@/server/visits/service';
import { SupabaseVisitRepository } from '@/server/visits/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ visitRef: string }> }) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  let status = 200;
  let routeTemplate = visitDetailPath('{visitId}');
  try {
    const { visitRef } = await context.params;
    routeTemplate = visitDetailPath('{visitId}');
    const { identity, client } = await resolveVisitRequest(request, headers);
    const result = await getVisitDetail(identity, visitRef, requestId, new SupabaseVisitRepository(client));
    return Response.json(result, { headers });
  } catch (error) {
    const publicError = error instanceof VisitServiceFailure && error.code === 'NOT_FOUND'
      ? new VisitRequestError(404, 'NOT_FOUND', error.message, false)
      : mapVisitRequestError(error);
    status = publicError.status;
    return visitErrorResponse(publicError, requestId, headers);
  } finally {
    logRouteRequest({ requestId, routeTemplate, method: 'GET', status, startedAt });
  }
}
