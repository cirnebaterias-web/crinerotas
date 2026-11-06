import { handleScrapRequest } from '@/server/scrap/http';
import { getScrapCollectionRoute } from '@/server/scrap-collection-routes/service';
import { SupabaseScrapCollectionRouteRepository } from '@/server/scrap-collection-routes/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ routeId: string }> }) {
  return handleScrapRequest(request, '/api/v1/logistics/routes/[routeId]', async ({ identity, client }, headers) => {
    const { routeId } = await context.params;
    return Response.json(await getScrapCollectionRoute(identity, routeId,
      new SupabaseScrapCollectionRouteRepository(client)), { headers });
  });
}
