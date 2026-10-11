import { z } from 'zod';
import { revisePickupScheduleRequestSchema, pickupScheduleSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { handleScrapRequest, mutationHeaders, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(request: Request, context: { params: Promise<{ scheduleId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/schedules/[scheduleId]', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, identity.capabilities.includes('scrap.read_operations') ? 'scrap.read_operations' : 'scrap.schedule_self');
    const scheduleId = parseScrap(z.uuid(), (await context.params).scheduleId);
    const { idempotencyKey } = mutationHeaders(request, false);
    const command = parseScrap(revisePickupScheduleRequestSchema, await readRouteJson(request));
    return Response.json(scrapResponse(pickupScheduleSchema, await scrapRpc(client, 'revise_pickup_schedule', {
      p_schedule_id: scheduleId, p_idempotency_key: idempotencyKey, p_command: command,
    })), { headers });
  });
}
