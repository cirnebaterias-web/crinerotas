import { z } from 'zod';
import { attachmentConfirmRequestSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { confirmScrapAttachment } from '@/server/scrap/evidence';
import { handleScrapRequest, mutationHeaders, parseScrap, requireScrapAccess } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ offlineId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/attachments/[offlineId]/confirm', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.collect_self');
    const offlineId = parseScrap(z.uuid(), (await context.params).offlineId);
    const { deviceId, idempotencyKey } = mutationHeaders(request);
    const command = parseScrap(attachmentConfirmRequestSchema, await readRouteJson(request));
    return Response.json(await confirmScrapAttachment(client, offlineId, deviceId, idempotencyKey, command,
      identity.id), { headers });
  });
}
