import { scrapClientListSchema } from '@cirne/contracts';
import { handleScrapRequest, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/clients', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.schedule_self');
    const query = new URL(request.url).searchParams.get('q')?.trim().slice(0, 120) ?? '';
    return Response.json(scrapResponse(scrapClientListSchema, { schemaVersion: 1,
      clients: await scrapRpc(client, 'search_scrap_clients', { p_query: query, p_limit: 30 }),
    }), { headers });
  });
}
