import { clientImportBatchSchema } from '@cirne/contracts';
import { readClientImportFile } from '@/server/client-imports/excel';
import { clientImportRpc, handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import { validateImportSellers } from '@/server/client-imports/service';
import { parseBearer } from '@/server/identity';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-imports', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.import');
    const command = await validateImportSellers(client, await readClientImportFile(request));
    const result = clientImportBatchSchema.parse(await clientImportRpc(client, 'execute_client_import', {
      p_command: command,
      p_origin: parseBearer(request.headers.get('authorization')) ? 'cli' : 'web',
    }));
    return Response.json(result, { status: result.replayed ? 200 : 201, headers });
  });
}
