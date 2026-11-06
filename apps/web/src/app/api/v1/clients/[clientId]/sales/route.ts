import { getClientSales, parseClientSalesQuery } from '@/server/client-sales/crm';
import { handleClientSalesRequest, requireSalesRead } from '@/server/client-sales/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request, context: { params: Promise<{ clientId: string }> }) {
  return handleClientSalesRequest(request, '/api/v1/clients/[clientId]/sales', async ({ identity, client }, headers) => {
    requireSalesRead(identity);
    const { clientId } = await context.params;
    return Response.json(await getClientSales(client, clientId, parseClientSalesQuery(request.url), new Date()), { headers });
  });
}
