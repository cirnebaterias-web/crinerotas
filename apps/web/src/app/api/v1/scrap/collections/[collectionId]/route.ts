import { z } from 'zod';
import { reviseScrapCollectionRequestSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { handleScrapRequest, mutationHeaders, parseScrap } from '@/server/scrap/http';
import { requireScrapRevisionAccess, reviseScrapCollection } from '@/server/scrap/revisions';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ collectionId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/collections/[collectionId]', async ({ identity, client }, headers) => {
    requireScrapRevisionAccess(identity);
    const collectionId = parseScrap(z.uuid(), (await context.params).collectionId);
    const { idempotencyKey } = mutationHeaders(request, false);
    const command = parseScrap(reviseScrapCollectionRequestSchema, await readRouteJson(request));
    return Response.json(await reviseScrapCollection(client, collectionId, idempotencyKey, command), { headers });
  });
}
