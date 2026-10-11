import { z } from 'zod';
import { confirmScrapReceiptRequestSchema, scrapReceiptSchema, reviseScrapReceiptRequestSchema } from '@cirne/contracts';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
import { handleScrapRequest, mutationHeaders, parseScrap, requireScrapAccess, scrapResponse, scrapRpc } from '@/server/scrap/http';
import { requireScrapRevisionAccess, reviseScrapReceipt } from '@/server/scrap/revisions';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, context: { params: Promise<{ collectionId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/collections/[collectionId]/receipt', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, 'scrap.receive');
    if (!identity.roles.includes('logistics')) {
      throw new RouteRequestError(403, 'FORBIDDEN', 'Recebimento exige perfil de Logística.', false);
    }
    const collectionId = parseScrap(z.uuid(), (await context.params).collectionId);
    const { idempotencyKey } = mutationHeaders(request, false);
    const command = parseScrap(confirmScrapReceiptRequestSchema, await readRouteJson(request));
    return Response.json(scrapResponse(scrapReceiptSchema, await scrapRpc(client, 'confirm_scrap_receipt', {
      p_collection_id: collectionId, p_idempotency_key: idempotencyKey, p_command: command,
    })), { headers });
  });
}
export async function PATCH(request: Request, context: { params: Promise<{ collectionId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/collections/[collectionId]/receipt', async ({ identity, client }, headers) => {
    requireScrapRevisionAccess(identity);
    const collectionId = parseScrap(z.uuid(), (await context.params).collectionId);
    const { idempotencyKey } = mutationHeaders(request, false);
    const command = parseScrap(reviseScrapReceiptRequestSchema, await readRouteJson(request));
    return Response.json(await reviseScrapReceipt(client, collectionId, idempotencyKey, command), { headers });
  });
}
