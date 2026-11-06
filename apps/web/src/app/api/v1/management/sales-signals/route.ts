import { getSalesSignals, parseSalesSignalsQuery } from '@/server/client-sales/crm';
import { handleClientSalesRequest, requireSalesRead } from '@/server/client-sales/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleClientSalesRequest(request, '/api/v1/management/sales-signals', async ({ identity, client }, headers) => {
    requireSalesRead(identity, true);
    return Response.json(await getSalesSignals(client, parseSalesSignalsQuery(request.url), new Date()), { headers });
  });
}
