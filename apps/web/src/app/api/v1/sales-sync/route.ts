import { handleSalesSyncRequest, requireSalesSyncCapability } from '@/server/sales-sync/http';
import { getSalesSyncStatus } from '@/server/sales-sync/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleSalesSyncRequest(request, '/api/v1/sales-sync', async ({ identity, client }, headers) => {
    requireSalesSyncCapability(identity);
    return Response.json(await getSalesSyncStatus(client), { headers });
  });
}
