import { randomUUID } from 'node:crypto';
import {
  saveCompetitorPricesRequestSchema,
  visitCompetitorPricesPath,
} from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createLogger, logRequest } from '@/server/logging';
import {
  enforceVisitCookieCsrf,
  mapVisitRequestError,
  readVisitJson,
  resolveVisitRequest,
  VisitRequestError,
  visitErrorResponse,
  visitResponseHeaders,
} from '@/server/visits/http';
import { publicVisitMessage, saveVisitCompetitorPrices } from '@/server/visits/service';
import { SupabaseVisitRepository } from '@/server/visits/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ visitRef: string }> },
) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  const { visitRef } = await context.params;
  let status = 200;
  try {
    enforceVisitCookieCsrf(request);
    const { identity, client } = await resolveVisitRequest(request, headers);
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('visit.start_self')) {
      throw new VisitRequestError(403, 'FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
    }
    const deviceId = request.headers.get('x-device-id');
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!deviceId || !idempotencyKey) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    const parsed = saveCompetitorPricesRequestSchema.safeParse(await readVisitJson(request));
    if (!parsed.success) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    const result = await saveVisitCompetitorPrices(
      visitRef,
      deviceId,
      idempotencyKey,
      parsed.data,
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
        routeTemplate: visitCompetitorPricesPath('{visitRef}'),
        method: 'PUT',
        status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } catch {
      // Logging must never replace the prepared public response.
    }
  }
}
