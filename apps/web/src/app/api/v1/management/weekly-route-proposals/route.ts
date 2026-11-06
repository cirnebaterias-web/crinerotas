import { z } from 'zod';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { generateAndSaveWeeklyProposal } from '@/server/route-proposals/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestSchema = z.object({
  schemaVersion: z.literal(1), weekStart: z.iso.date(), sellerId: z.uuid(), idempotencyKey: z.uuid(),
}).strict();

export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/management/weekly-route-proposals',
    async ({ identity, client }, headers) => {
      if (!identity.roles.some((role) => role === 'manager' || role === 'administrator') ||
          !identity.capabilities.includes('route.plan_scoped')) {
        throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
      }
      const command = requestSchema.safeParse(await readRouteJson(request));
      if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise a semana e o vendedor.', false);
      return Response.json(await generateAndSaveWeeklyProposal(client, command.data), { status: 201, headers });
    });
}
