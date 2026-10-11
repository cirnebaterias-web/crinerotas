import { saveScrapPointRequestSchema, scrapPointListSchema, scrapPointSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { handleScrapRequest, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/points', async ({ identity, client }, headers) => {
    const includeInactive = new URL(request.url).searchParams.get('includeInactive') === 'true';
    requireScrapAccess(identity, includeInactive ? 'scrap.manage_points' :
      identity.capabilities.includes('scrap.collect_self') ? 'scrap.collect_self' : 'scrap.read_operations');
    return Response.json(scrapResponse(scrapPointListSchema, { schemaVersion: 1,
      points: await scrapRpc(client, 'list_scrap_points', { p_include_inactive: includeInactive }),
    }), { headers });
  });
}
async function save(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/points', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.manage_points');
    const command = parseScrap(saveScrapPointRequestSchema, await readRouteJson(request));
    return Response.json(scrapResponse(scrapPointSchema, await scrapRpc(client, 'save_scrap_point', {
      p_command: command,
    })), { status: request.method === 'POST' ? 201 : 200, headers });
  });
}
export const POST = save;
export const PUT = save;
