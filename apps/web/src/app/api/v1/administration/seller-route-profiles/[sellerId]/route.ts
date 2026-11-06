import { z } from 'zod';
import {
  sellerRouteProfileMutationResponseSchema, sellerRouteProfilePath, sellerRouteProfileSchema,
  updateSellerRouteProfileRequestSchema,
} from '@cirne/contracts';
import { handleClientImportRequest, clientImportRpc } from '@/server/client-imports/http';
import { clientRequestOrigin } from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ sellerId: string }> };

function requireManager(identity: { roles: readonly string[] }) {
  if (!identity.roles.some((role) => role === 'manager' || role === 'administrator')) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
  }
}

async function sellerId(context: Context) {
  const parsed = z.uuid().safeParse((await context.params).sellerId.toLowerCase());
  if (!parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Vendedor inválido.', false);
  return parsed.data;
}

export async function GET(request: Request, context: Context) {
  return handleClientImportRequest(request, sellerRouteProfilePath('{sellerId}'), async ({ identity, client }, headers) => {
    requireManager(identity);
    const result = sellerRouteProfileSchema.parse(await clientImportRpc(client, 'get_seller_route_profile', {
      p_seller_id: await sellerId(context),
    }));
    return Response.json(result, { headers });
  });
}

export async function PUT(request: Request, context: Context) {
  return handleClientImportRequest(request, sellerRouteProfilePath('{sellerId}'), async ({ identity, client }, headers) => {
    requireManager(identity);
    const command = updateSellerRouteProfileRequestSchema.safeParse(await readRouteJson(request));
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise o perfil operacional.', false);
    const result = sellerRouteProfileMutationResponseSchema.parse(await clientImportRpc(client,
      'update_seller_route_profile', { p_seller_id: await sellerId(context), p_command: command.data,
        p_origin: clientRequestOrigin(request) }));
    return Response.json(result, { headers });
  });
}
