import { scrapAttachmentUploadIntentRequestSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { createScrapUploadIntent } from '@/server/scrap/evidence';
import { handleScrapRequest, mutationHeaders, parseScrap, requireScrapAccess } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/attachments/upload-intents', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.collect_self');
    const { deviceId, idempotencyKey } = mutationHeaders(request);
    const command = parseScrap(scrapAttachmentUploadIntentRequestSchema, await readRouteJson(request));
    return Response.json(await createScrapUploadIntent(client, deviceId, idempotencyKey, command), { status: 201, headers });
  });
}
