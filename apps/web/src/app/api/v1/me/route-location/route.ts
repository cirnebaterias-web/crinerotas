import { dailySellerLocationCaptureSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { captureDailySellerLocation } from '@/server/route-proposals/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/me/route-location', async ({ identity, client }, headers) => {
    if (!identity.roles.includes('seller') || !identity.capabilities.includes('route.read_self')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
    }
    const command = dailySellerLocationCaptureSchema.safeParse(await readRouteJson(request));
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Localização inválida ou imprecisa.', false);
    return Response.json(await captureDailySellerLocation(client, command.data), { status: 201, headers });
  });
}
