import { scrapOperationsSchema } from '@cirne/contracts';
import { handleScrapRequest, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/collections', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, identity.capabilities.includes('scrap.read_operations') ? 'scrap.read_operations' : 'scrap.collect_self');
    const operations = scrapResponse(scrapOperationsSchema, await scrapRpc(client, 'list_scrap_operations'));
    return Response.json({ schemaVersion: 1, collections: operations.collections, totals: operations.totals }, { headers });
  });
}
