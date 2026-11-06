import { salesSyncRequestSchema } from '@cirne/contracts';
import { handleSalesSyncRequest, requireSalesSyncCapability } from '@/server/sales-sync/http';
import { beginSalesSync } from '@/server/sales-sync/service';
import { parseBearer } from '@/server/identity';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return handleSalesSyncRequest(request, '/api/v1/sales-sync/runs', async ({ identity, client }, headers) => {
    requireSalesSyncCapability(identity);
    const command = salesSyncRequestSchema.safeParse(await readRouteJson(request));
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Comando de vendas inválido.', false);
    return Response.json(await beginSalesSync(client, identity, command.data,
      parseBearer(request.headers.get('authorization')) ? 'cli' : 'web'), { headers });
  });
}
