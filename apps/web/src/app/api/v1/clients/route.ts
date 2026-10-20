import { clientListQuerySchema, clientListResponseSchema, createClientRequestSchema } from '@cirne/contracts';
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
    const parsed = clientListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os filtros da consulta.', false);
    }
    const result = await clientImportRpc(client, 'list_management_clients', {
      p_query: parsed.data.q,
      p_page: parsed.data.page,
      p_page_size: parsed.data.pageSize,
    });
    return Response.json(clientListResponseSchema.parse(result), { headers });
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
