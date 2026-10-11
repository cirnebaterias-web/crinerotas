import { randomUUID } from 'node:crypto';
import { saveVisitCheckinEvidenceRequestSchema } from '@cirne/contracts';
import {
  enforceVisitCookieCsrf, mapVisitRequestError, readVisitJson, resolveVisitRequest,
  VisitRequestError, visitErrorResponse, visitResponseHeaders,
} from '@/server/visits/http';
import { saveVisitCheckinEvidence } from '@/server/visits/evidence';
import { publicVisitMessage } from '@/server/visits/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request, context: { params: Promise<{ visitRef: string }> }) {
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  try {
    enforceVisitCookieCsrf(request);
    const { identity, client } = await resolveVisitRequest(request, headers);
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('visit.start_self')) {
      throw new VisitRequestError(403, 'FORBIDDEN', publicVisitMessage('FORBIDDEN'), false);
    }
    const deviceId = request.headers.get('x-device-id');
    const idempotencyKey = request.headers.get('idempotency-key');
    const parsed = saveVisitCheckinEvidenceRequestSchema.safeParse(await readVisitJson(request));
    const { visitRef } = await context.params;
    if (!deviceId || !idempotencyKey || !parsed.success || parsed.data.offlineId !== visitRef) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    return Response.json(await saveVisitCheckinEvidence(
      client, deviceId, idempotencyKey, parsed.data,
    ), { headers });
  } catch (error) {
    return visitErrorResponse(mapVisitRequestError(error), requestId, headers);
  }
}
