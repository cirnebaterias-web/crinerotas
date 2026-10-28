import { randomUUID } from 'node:crypto';
import { attachmentDownloadUrlPath } from '@cirne/contracts';
import { logRouteRequest } from '@/server/routes/http';
import {
  mapVisitRequestError, resolveVisitRequest, VisitRequestError,
  visitErrorResponse, visitResponseHeaders,
} from '@/server/visits/http';
import { createVisitAttachmentDownloadUrl, VisitServiceFailure } from '@/server/visits/service';
import { SupabaseVisitRepository } from '@/server/visits/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ attachmentRef: string }> }) {
  const startedAt = performance.now();
  const requestId = randomUUID();
  const headers = visitResponseHeaders(requestId);
  let status = 200;
  const routeTemplate = attachmentDownloadUrlPath('{attachmentId}');
  try {
    const { attachmentRef } = await context.params;
    const { identity, client } = await resolveVisitRequest(request, headers);
    return Response.json(await createVisitAttachmentDownloadUrl(
      identity, attachmentRef, requestId, new SupabaseVisitRepository(client),
    ), { headers });
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
