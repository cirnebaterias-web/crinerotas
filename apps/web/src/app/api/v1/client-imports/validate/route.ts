import { readClientImportFile } from '@/server/client-imports/excel';
import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import { validateImportSellers } from '@/server/client-imports/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-imports/validate', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.import');
    return Response.json(await validateImportSellers(client, await readClientImportFile(request)), { headers });
  });
}
