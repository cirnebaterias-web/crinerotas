import { clientListResponseSchema } from '@cirne/contracts';
import { clientImportRpc, handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/clients', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.read');
    const clients = await clientImportRpc(client, 'list_import_clients', { p_limit: 100 });
    return Response.json(clientListResponseSchema.parse({ schemaVersion: 1, clients }), { headers });
  });
}
