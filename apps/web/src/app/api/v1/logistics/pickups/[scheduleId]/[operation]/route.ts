import { changeLogisticsPickup } from '@/server/logistics-pickups/service';
import { SupabaseLogisticsPickupRepository } from '@/server/logistics-pickups/supabase-repository';
import { handleScrapRequest } from '@/server/scrap/http';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ scheduleId: string; operation: string }> }) {
  return handleScrapRequest(request, '/api/v1/logistics/pickups/[scheduleId]/[operation]', async ({ identity, client }, headers) => {
    if (new URL(request.url).search) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Operação inválida.', false);
    const { scheduleId, operation } = await context.params;
    return Response.json(await changeLogisticsPickup(identity, scheduleId, operation,
      request.headers.get('idempotency-key'), await readRouteJson(request), new SupabaseLogisticsPickupRepository(client)), { headers });
  });
}
