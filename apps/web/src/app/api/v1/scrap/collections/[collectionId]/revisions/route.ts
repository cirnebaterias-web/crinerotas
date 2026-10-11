import { z } from 'zod';
import { scrapCollectionRevisionsSchema } from '@cirne/contracts';
import { handleScrapRequest, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ collectionId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/collections/[collectionId]/revisions', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.read_operations');
    const collectionId = parseScrap(z.uuid(), (await context.params).collectionId);
    return Response.json(scrapResponse(scrapCollectionRevisionsSchema, { schemaVersion: 1,
      revisions: await scrapRpc(client, 'list_scrap_collection_revisions', { p_collection_id: collectionId }),
    }), { headers });
  });
}
