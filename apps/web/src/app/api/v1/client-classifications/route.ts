import { handleClientImportRequest } from '@/server/client-imports/http';
import { listClassifications } from '@/server/field-outcomes/service';
export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export function GET(request: Request) { return handleClientImportRequest(request, '/api/v1/client-classifications',
  async ({ client }, headers) => Response.json(await listClassifications(client), { headers })); }
