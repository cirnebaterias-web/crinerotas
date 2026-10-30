import { administrationPath } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { getAdministrationSnapshot } from '@/server/administration/service';
import { SupabaseAdministrationRepository } from '@/server/administration/supabase-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleClientImportRequest(request, administrationPath, async ({ identity, client }, headers) => {
    const result = await getAdministrationSnapshot(
      identity, new SupabaseAdministrationRepository(client),
    );
    return Response.json(result, { headers });
  });
}
