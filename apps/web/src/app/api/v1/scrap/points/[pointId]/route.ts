import { z } from 'zod';
import { saveScrapPointRequestSchema, scrapPointSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { handleScrapRequest, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ pointId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/points/[pointId]', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.manage_points');
    const id = parseScrap(z.uuid(), (await context.params).pointId);
    const value = await readRouteJson(request);
    const command = parseScrap(saveScrapPointRequestSchema,
      typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value, id } : value);
    return Response.json(scrapResponse(scrapPointSchema, await scrapRpc(client, 'save_scrap_point', {
      p_command: command,
    })), { headers });
  });
}
