import { randomUUID } from 'node:crypto';
import { attachmentUploadIntentRequestSchema } from '@cirne/contracts';
import {
  enforceVisitCookieCsrf, mapVisitRequestError, readVisitJson, resolveVisitRequest,
  VisitRequestError, visitErrorResponse, visitResponseHeaders,
} from '@/server/visits/http';
import { publicVisitMessage } from '@/server/visits/service';
import { createEvidenceUploadIntent } from '@/server/visits/evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
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
    const parsed = attachmentUploadIntentRequestSchema.safeParse(await readVisitJson(request));
    if (!deviceId || !idempotencyKey || !parsed.success) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    return Response.json(await createEvidenceUploadIntent(client, deviceId, idempotencyKey, parsed.data), {
      status: 201, headers,
    });
  } catch (error) {
    return visitErrorResponse(mapVisitRequestError(error), requestId, headers);
  }
}
