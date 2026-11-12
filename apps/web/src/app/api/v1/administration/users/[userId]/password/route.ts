import { z } from 'zod';
import { administrationUserPasswordPath, resetAdministrationPasswordRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { resetAdministrationPassword } from '@/server/administration/service';
import { SupabaseAdministrationRepository } from '@/server/administration/supabase-repository';
import { createAdministrationAuthGateway } from '@/server/administration/auth-admin';
import { clientRequestOrigin } from '@/server/clients/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ userId: string }> };

export async function POST(request: Request, context: Context) {
  const rawUserId = (await context.params).userId.toLowerCase();
  return handleClientImportRequest(request, administrationUserPasswordPath('{userId}'),
    async ({ identity, client }, headers) => {
      const userId = z.uuid().safeParse(rawUserId);
      const command = resetAdministrationPasswordRequestSchema.safeParse(await readRouteJson(request));
      if (!userId.success || !command.success) {
        throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Revise a nova senha temporaria.', false);
      }
      const result = await resetAdministrationPassword(identity, userId.data, command.data,
        clientRequestOrigin(request), new SupabaseAdministrationRepository(client),
        createAdministrationAuthGateway());
      return Response.json(result, { headers });
    });
}
