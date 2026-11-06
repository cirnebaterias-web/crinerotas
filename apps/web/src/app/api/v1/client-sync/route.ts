import { clientSheetSyncRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import { getClientSheetSyncStatus, synchronizeClientSheet } from '@/server/client-sheet-sync/service';
import { parseBearer } from '@/server/identity';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-sync', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.import');
    return Response.json(await getClientSheetSyncStatus(client), { headers });
  });
}
export function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-sync', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.import');
    const command = clientSheetSyncRequestSchema.safeParse(await readRouteJson(request));
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Comando de atualização inválido.', false);
    const result = await synchronizeClientSheet(client, identity, command.data,
      parseBearer(request.headers.get('authorization')) ? 'cli' : 'web');
    return Response.json(result, { headers });
  });
}
