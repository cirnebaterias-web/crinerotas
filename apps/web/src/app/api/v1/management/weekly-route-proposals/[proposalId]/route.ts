import { z } from 'zod';
import { decideWeeklyRouteProposalRequestSchema, reviseWeeklyRouteProposalRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { decideWeeklyProposal, inspectWeeklyProposal, reviseWeeklyProposal } from '@/server/route-proposals/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ proposalId: string }> };

function requireManager(identity: { roles: readonly string[]; capabilities: readonly string[] }) {
  if (!identity.roles.some((role) => role === 'manager' || role === 'administrator') ||
      !identity.capabilities.includes('route.plan_scoped')) {
    throw new RouteRequestError(403, 'FORBIDDEN', 'Operação não autorizada.', false);
  }
}
async function proposalId(context: Context) {
  const parsed = z.uuid().safeParse((await context.params).proposalId);
  if (!parsed.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Proposta inválida.', false);
  return parsed.data;
}

export async function GET(request: Request, context: Context) {
  return handleClientImportRequest(request, '/api/v1/management/weekly-route-proposals/{proposalId}',
    async ({ identity, client }, headers) => {
      requireManager(identity);
      return Response.json(await inspectWeeklyProposal(client, await proposalId(context)), { headers });
    });
}

export async function PATCH(request: Request, context: Context) {
  return handleClientImportRequest(request, '/api/v1/management/weekly-route-proposals/{proposalId}',
    async ({ identity, client }, headers) => {
      requireManager(identity);
      const body = await readRouteJson(request);
      const revision = reviseWeeklyRouteProposalRequestSchema.safeParse(body);
      if (revision.success) return Response.json(await reviseWeeklyProposal(client, await proposalId(context), revision.data), { headers });
      const decision = decideWeeklyRouteProposalRequestSchema.safeParse(body);
      if (decision.success) return Response.json(await decideWeeklyProposal(client, await proposalId(context), decision.data), { headers });
      throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Comando de proposta inválido.', false);
    });
}
