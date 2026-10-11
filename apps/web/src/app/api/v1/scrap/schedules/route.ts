import { createPickupScheduleRequestSchema, pickupScheduleSchema, scrapOperationsSchema } from '@cirne/contracts';
import { readRouteJson } from '@/server/routes/http';
import { handleScrapRequest, mutationHeaders, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/schedules', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, identity.capabilities.includes('scrap.read_operations') ? 'scrap.read_operations' : 'scrap.schedule_self');
    const operations = scrapResponse(scrapOperationsSchema, await scrapRpc(client, 'list_scrap_operations'));
    return Response.json({ schemaVersion: 1, schedules: operations.schedules, totals: operations.totals }, { headers });
  });
}
export async function POST(request: Request) {
  return handleScrapRequest(request, '/api/v1/scrap/schedules', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.schedule_self');
    const { deviceId, idempotencyKey } = mutationHeaders(request);
    const command = parseScrap(createPickupScheduleRequestSchema, await readRouteJson(request));
    return Response.json(scrapResponse(pickupScheduleSchema, await scrapRpc(client, 'create_pickup_schedule', {
      p_device_id: deviceId, p_idempotency_key: idempotencyKey, p_command: command,
    })), { status: 201, headers });
  });
}
