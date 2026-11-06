import { z } from 'zod';
import { salesSyncStageRequestSchema, salesSyncPublishRequestSchema, salesSyncFailRequestSchema } from '@cirne/contracts';
import { parseBearer } from '../identity';
import { RouteRequestError } from '../routes/http';
import { handleSalesSyncRequest, readSalesSyncJson, requireSalesSyncCapability } from './http';
import { stageSalesSync, publishSalesSync, failSalesSync } from './service';

export function salesRunCommand(action: 'stage' | 'publish' | 'fail', request: Request,
  params: Promise<{ runId: string }>) {
  return handleSalesSyncRequest(request, `/api/v1/sales-sync/runs/[runId]/${action}`, async ({ identity, client }, headers) => {
    requireSalesSyncCapability(identity);
    if (!parseBearer(request.headers.get('authorization'))) throw new RouteRequestError(403, 'FORBIDDEN', 'Use a identidade da CLI.', false);
    const id = z.uuid().safeParse((await params).runId);
    if (!id.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Identificador inválido.', false);
    const body = await readSalesSyncJson(request);
    if (action === 'stage') {
      const command = salesSyncStageRequestSchema.safeParse(body);
      if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Lote de vendas inválido.', false);
      return Response.json(await stageSalesSync(client, id.data, command.data), { headers });
    }
    if (action === 'publish') {
      const command = salesSyncPublishRequestSchema.safeParse(body);
      if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Publicação inválida.', false);
      return Response.json(await publishSalesSync(client, id.data, command.data), { headers });
    }
    const command = salesSyncFailRequestSchema.safeParse(body);
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Falha inválida.', false);
    return Response.json(await failSalesSync(client, id.data, command.data), { headers });
  });
}
