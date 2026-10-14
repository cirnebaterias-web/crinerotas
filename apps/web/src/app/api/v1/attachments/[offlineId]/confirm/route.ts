import { randomUUID } from 'node:crypto';
import { attachmentConfirmRequestSchema } from '@cirne/contracts';
import {
  enforceVisitCookieCsrf, mapVisitRequestError, readVisitJson, resolveVisitRequest,
  VisitRequestError, visitErrorResponse, visitResponseHeaders,
} from '@/server/visits/http';
import { publicVisitMessage } from '@/server/visits/service';
import { confirmEvidenceAttachment } from '@/server/visits/evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ offlineId: string }> }) {
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
    const parsed = attachmentConfirmRequestSchema.safeParse(await readVisitJson(request));
    const { offlineId } = await context.params;
    if (!deviceId || !idempotencyKey || !parsed.success) {
      throw new VisitRequestError(422, 'VALIDATION_FAILED', publicVisitMessage('VALIDATION_FAILED'), false);
    }
    return Response.json(await confirmEvidenceAttachment(
      client, offlineId, deviceId, idempotencyKey, parsed.data, identity.id,
    ), { headers });
  } catch (error) {
    return visitErrorResponse(mapVisitRequestError(error), requestId, headers);
  }
}
