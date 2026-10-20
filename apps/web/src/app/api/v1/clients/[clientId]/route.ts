import { updateClientRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import {
  clientRequestOrigin,
  getManagedClient,
  requireClientId,
  requireClientIdempotencyKey,
  updateManagedClient,
} from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ clientId: string }> };

export async function GET(request: Request, context: Context) {
  return handleClientImportRequest(request, '/api/v1/clients/{clientId}', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.manage');
    const clientId = requireClientId((await context.params).clientId);
    return Response.json(await getManagedClient(client, clientId), { headers });
  });
}
export async function PATCH(request: Request, context: Context) {
  return handleClientImportRequest(request, '/api/v1/clients/{clientId}', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.manage');
    const clientId = requireClientId((await context.params).clientId);
    const parsed = updateClientRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados e informe o motivo da correção.', false);
    }
    const result = await updateManagedClient(
      client, clientId, parsed.data, requireClientIdempotencyKey(request), clientRequestOrigin(request),
    );
    return Response.json(result, { headers });
  });
}
