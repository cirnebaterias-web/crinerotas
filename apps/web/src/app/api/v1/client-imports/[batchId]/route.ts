import { clientImportBatchSchema } from '@cirne/contracts';
import { clientImportRpc, handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ batchId: string }> }) {
  return handleClientImportRequest(request, '/api/v1/client-imports/{batchId}', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.import');
    const { batchId } = await context.params;
    return Response.json(clientImportBatchSchema.parse(await clientImportRpc(client, 'get_client_import', {
      p_batch_id: batchId,
    })), { headers });
  });
}
