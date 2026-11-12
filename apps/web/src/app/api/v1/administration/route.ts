import { administrationPath, createAdministrationUserRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { createAdministrationUser, getAdministrationSnapshot } from '@/server/administration/service';
import { SupabaseAdministrationRepository } from '@/server/administration/supabase-repository';
import { createAdministrationAuthGateway } from '@/server/administration/auth-admin';
import { clientRequestOrigin } from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleClientImportRequest(request, administrationPath, async ({ identity, client }, headers) => {
    const result = await getAdministrationSnapshot(
      identity, new SupabaseAdministrationRepository(client), createAdministrationAuthGateway(),
    );
    return Response.json(result, { headers });
  });
}

export async function POST(request: Request) {
  return handleClientImportRequest(request, administrationPath, async ({ identity, client }, headers) => {
    const command = createAdministrationUserRequestSchema.safeParse(await readRouteJson(request));
    if (!command.success) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados do novo acesso.', false);
    const result = await createAdministrationUser(identity, command.data, clientRequestOrigin(request),
      new SupabaseAdministrationRepository(client), createAdministrationAuthGateway());
    return Response.json(result, { status: 201, headers });
  });
}
