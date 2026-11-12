import { randomUUID } from 'node:crypto';
import { saveVisitSalesRequestSchema, visitSalesReadResultSchema, visitSalesPath } from '@cirne/contracts';
import { readServerConfig } from '@cirne/config/server';
import { createLogger, logRequest } from '@/server/logging';
import { enforceVisitCookieCsrf, mapVisitRequestError, readVisitJson, resolveVisitRequest,
  VisitRequestError, visitErrorResponse, visitResponseHeaders } from '@/server/visits/http';
import { publicVisitMessage, saveVisitSales } from '@/server/visits/service';
import { SupabaseVisitRepository } from '@/server/visits/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request, context: { params: Promise<{ visitRef: string }> }, write: boolean) {
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  const startedAt = performance.now();
  let status = 200;
  try {
    if (write) enforceVisitCookieCsrf(request);
    const { identity, client } = await resolveVisitRequest(request, headers);
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('visit.start_self') ||
        !identity.capabilities.includes('sync.write_self')) {
      throw new VisitRequestError(403, 'FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
    }
    const { visitRef } = await context.params;
    const deviceId = request.headers.get('x-device-id');
    if (!deviceId || !saveVisitSalesRequestSchema.shape.offlineId.safeParse(visitRef).success ||
        !saveVisitSalesRequestSchema.shape.offlineId.safeParse(deviceId).success) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', 'Identificador inválido.', false);
    }
    const repository = new SupabaseVisitRepository(client);
    if (!write) {
      const report = await repository.getSales(deviceId, visitRef);
      return Response.json(visitSalesReadResultSchema.parse({ schemaVersion: 1, sales: report }), { headers });
    }
    const key = request.headers.get('idempotency-key');
    const command = saveVisitSalesRequestSchema.safeParse(await readVisitJson(request));
    if (!key || !command.success) throw new VisitRequestError(422, 'VALIDATION_FAILED', 'Informe inválido.', false);
    return Response.json(await saveVisitSales(visitRef, deviceId, key, command.data, repository), { headers });
  } catch (error) {
    const failure = mapVisitRequestError(error);
    status = failure.status;
    return visitErrorResponse(failure, requestId, headers);
  } finally {
    try {
      logRequest(createLogger(readServerConfig(process.env).LOG_LEVEL), {
        requestId, routeTemplate: visitSalesPath('{visitRef}'), method: write ? 'PUT' : 'GET',
        status, durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } catch { /* Logging cannot replace a prepared public response. */ }
  }
}

export const PUT = (request: Request, context: { params: Promise<{ visitRef: string }> }) => handle(request, context, true);
export const GET = (request: Request, context: { params: Promise<{ visitRef: string }> }) => handle(request, context, false);
