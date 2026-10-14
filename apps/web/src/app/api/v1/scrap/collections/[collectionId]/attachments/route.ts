import { z } from 'zod';
import { listScrapEvidence } from '@/server/scrap/evidence';
import { handleScrapRequest, parseScrap, requireScrapAccess } from '@/server/scrap/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ collectionId: string }> }) {
  return handleScrapRequest(request, '/api/v1/scrap/collections/[collectionId]/attachments', async ({ identity, client }, headers) => {
    requireScrapAccess(identity, identity.capabilities.includes('scrap.read_operations') ? 'scrap.read_operations' : 'scrap.collect_self');
    const collectionId = parseScrap(z.uuid(), (await context.params).collectionId);
    return Response.json(await listScrapEvidence(client, collectionId), { headers });
  });
}
