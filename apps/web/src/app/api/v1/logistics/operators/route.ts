import { logisticsOperatorsPath } from '@cirne/contracts';
import { listLogisticsOperators } from '@/server/logistics-pickups/service';
import { SupabaseLogisticsPickupRepository } from '@/server/logistics-pickups/supabase-repository';
import { handleScrapRequest } from '@/server/scrap/http';
import { RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleScrapRequest(request, logisticsOperatorsPath, async ({ identity, client }, headers) => {
    if (new URL(request.url).search) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Consulta inválida.', false);
    return Response.json(await listLogisticsOperators(identity, new SupabaseLogisticsPickupRepository(client)), { headers });
  });
}
