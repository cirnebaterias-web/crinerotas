import { z } from 'zod';
import { administrationUserPath, updateAdministrationUserRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { updateAdministrationUser } from '@/server/administration/service';
import { SupabaseAdministrationRepository } from '@/server/administration/supabase-repository';
import { clientRequestOrigin } from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ userId: string }> };

export async function PUT(request: Request, context: Context) {
  const rawUserId = (await context.params).userId;
  return handleClientImportRequest(request, administrationUserPath('{userId}'),
    async ({ identity, client }, headers) => {
      const userId = z.uuid().safeParse(rawUserId.toLowerCase());
      if (!userId.success) {
        throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Identificador de usuario invalido.', false);
      }
      const command = updateAdministrationUserRequestSchema.safeParse(await readRouteJson(request));
      if (!command.success) {
        throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise os dados administrativos.', false);
      }
      const result = await updateAdministrationUser(
        identity, userId.data, command.data, clientRequestOrigin(request),
        new SupabaseAdministrationRepository(client),
      );
      return Response.json(result, { headers });
    });
}
