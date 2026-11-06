import { handleClientImportRequest, requireClientCapability } from '@/server/client-imports/http';
import { createClientImportTemplate } from '@/server/client-imports/template';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleClientImportRequest(request, '/api/v1/client-imports/template', async ({ identity }, headers) => {
    requireClientCapability(identity, 'clients.import');
    const buffer = await createClientImportTemplate();
    headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    headers.set('Content-Disposition', 'attachment; filename="modelo-clientes-cirne.xlsx"');
    return new Response(buffer, { headers });
  });
}
