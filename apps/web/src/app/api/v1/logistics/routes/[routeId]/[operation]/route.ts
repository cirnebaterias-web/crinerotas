import { handleScrapRequest, mutationHeaders } from '@/server/scrap/http';
import { changeScrapCollectionRoute } from '@/server/scrap-collection-routes/service';
import { SupabaseScrapCollectionRouteRepository } from '@/server/scrap-collection-routes/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request,
  context: { params: Promise<{ routeId: string; operation: string }> }) {
  return handleScrapRequest(request, '/api/v1/logistics/routes/[routeId]/[operation]',
    async ({ identity, client }, headers) => {
      const { routeId, operation } = await context.params;
      const { idempotencyKey } = mutationHeaders(request, false);
      return Response.json(await changeScrapCollectionRoute(identity, routeId, operation, idempotencyKey,
        await request.json(), new SupabaseScrapCollectionRouteRepository(client)), { headers });
    });
}
