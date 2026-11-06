import { scrapCollectionRoutesPath } from '@cirne/contracts';
import { handleScrapRequest, mutationHeaders } from '@/server/scrap/http';
import { RouteRequestError } from '@/server/routes/http';
import {
  createScrapCollectionRoute, listScrapCollectionRoutes,
} from '@/server/scrap-collection-routes/service';
import { SupabaseScrapCollectionRouteRepository } from '@/server/scrap-collection-routes/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleScrapRequest(request, scrapCollectionRoutesPath, async ({ identity, client }, headers) => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'date') || query.getAll('date').length !== 1) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Informe uma única data para as rotas.', false);
    }
    return Response.json(await listScrapCollectionRoutes(identity, query.get('date'),
      new SupabaseScrapCollectionRouteRepository(client)), { headers });
  });
}

export async function POST(request: Request) {
  return handleScrapRequest(request, scrapCollectionRoutesPath, async ({ identity, client }, headers) => {
    const { idempotencyKey } = mutationHeaders(request, false);
    return Response.json(await createScrapCollectionRoute(identity, idempotencyKey, await request.json(),
      new SupabaseScrapCollectionRouteRepository(client)), { status: 201, headers });
  });
}
