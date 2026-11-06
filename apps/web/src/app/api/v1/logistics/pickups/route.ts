import { logisticsPickupsPath } from '@cirne/contracts';
import { listLogisticsPickups } from '@/server/logistics-pickups/service';
import { SupabaseLogisticsPickupRepository } from '@/server/logistics-pickups/supabase-repository';
import { handleScrapRequest } from '@/server/scrap/http';
import { RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleScrapRequest(request, logisticsPickupsPath, async ({ identity, client }, headers) => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'date') || query.getAll('date').length !== 1) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Informe uma única data para a rota.', false);
    }
    return Response.json(await listLogisticsPickups(identity, query.get('date'), new SupabaseLogisticsPickupRepository(client)), { headers });
  });
}
