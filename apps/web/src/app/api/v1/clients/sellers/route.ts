import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import { listManagedClientSellers } from '@/server/clients/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/clients/sellers', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.manage');
    return Response.json(await listManagedClientSellers(client), { headers });
  });
}
