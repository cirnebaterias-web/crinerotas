import { clientListResponseSchema, createClientRequestSchema } from '@cirne/contracts';
import { clientImportRpc, handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import {
  clientRequestOrigin,
  createManagedClient,
  requireClientIdempotencyKey,
} from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/clients', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.read');
    const clients = await clientImportRpc(client, 'list_import_clients', { p_limit: 100 });
    return Response.json(clientListResponseSchema.parse({ schemaVersion: 1, clients }), { headers });
  });
}
export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/clients', async ({ identity, client }, headers) => {
    requireClientCapability(identity, 'clients.manage');
    const parsed = createClientRequestSchema.safeParse(await readRouteJson(request));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados do cliente.', false);
    }
    const result = await createManagedClient(
      client, parsed.data, requireClientIdempotencyKey(request), clientRequestOrigin(request),
    );
    return Response.json(result, { status: result.replayed ? 200 : 201, headers });
  });
}
