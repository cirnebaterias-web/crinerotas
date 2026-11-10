import { weeklyRouteProposalMutationRequestSchema } from '@cirne/contracts';
import { z } from 'zod';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { getWeeklyRoutePlanningCandidates, mutateWeeklyProposal } from '@/server/route-proposals/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({ sellerId: z.uuid(), weekStart: z.iso.date() }).strict();

export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/management/weekly-route-proposals',
    async ({ identity, client }, headers) => {
      if (!identity.roles.some((role) => role === 'manager' || role === 'administrator')
          || !identity.capabilities.includes('route.plan_scoped')) {
        throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
      }
      const url = new URL(request.url);
      const query = querySchema.safeParse({ sellerId: url.searchParams.get('sellerId'),
        weekStart: url.searchParams.get('weekStart') });
      if (!query.success) throw new RouteRequestError(422, 'VALIDATION_FAILED',
        'Revise a semana e o vendedor.', false);
      return Response.json(await getWeeklyRoutePlanningCandidates(client,
        { schemaVersion: 1, ...query.data }), { headers });
    });
}

export async function POST(request: Request) {
  return handleClientImportRequest(request, '/api/v1/management/weekly-route-proposals',
    async ({ identity, client }, headers) => {
      if (!identity.roles.some((role) => role === 'manager' || role === 'administrator') ||
          !identity.capabilities.includes('route.plan_scoped')) {
        throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
      }
      const command = weeklyRouteProposalMutationRequestSchema.safeParse(await readRouteJson(request));
      if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise a semana e o vendedor.', false);
      const result = await mutateWeeklyProposal(client, command.data);
      return Response.json(result, { status: result.outcome === 'created' ? 201 : 200, headers });
    });
}
