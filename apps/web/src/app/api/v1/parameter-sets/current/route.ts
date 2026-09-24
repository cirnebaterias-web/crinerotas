import { randomUUID } from 'node:crypto';
import { currentParameterSetPath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createLogger, logRequest } from '@/server/logging';
import {
  mapVisitRequestError,
  resolveVisitRequest,
  VisitRequestError,
  visitErrorResponse,
  visitResponseHeaders,
} from '@/server/visits/http';
import {
  getCurrentCompetitorPriceParameters,
  publicVisitMessage,
} from '@/server/visits/service';
import { SupabaseVisitRepository } from '@/server/visits/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  let status = 200;
  try {
    const at = new URL(request.url).searchParams.get('at');
    if (!at) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    const { client } = await resolveVisitRequest(request, headers);
    const result = await getCurrentCompetitorPriceParameters(
      at,
      new SupabaseVisitRepository(client),
    );
    return Response.json(result, { status, headers });
  } catch (error) {
    const publicError = mapVisitRequestError(error);
    status = publicError.status;
    return visitErrorResponse(publicError, requestId, headers);
  } finally {
    try {
      const config = readServerConfig(process.env);
      logRequest(createLogger(config.LOG_LEVEL), {
        requestId,
        routeTemplate: currentParameterSetPath,
        method: 'GET',
        status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } catch {
      // Logging must never replace the prepared public response.
    }
  }
}
