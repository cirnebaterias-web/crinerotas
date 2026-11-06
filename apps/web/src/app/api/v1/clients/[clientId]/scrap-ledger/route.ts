import { clientScrapSummarySchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { RouteRequestError } from '@/server/routes/http';
import { getClientScrapSummary } from '@/server/scrap-ledger-sync/service';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(request:Request,context:{params:Promise<{clientId:string}>}){return handleClientImportRequest(request,'/api/v1/clients/[clientId]/scrap-ledger',async({identity,client},headers)=>{if(!identity.capabilities.includes('scrap_ledger.read'))throw new RouteRequestError(403,'FORBIDDEN','Operação não autorizada.',false);const{id}= {id:(await context.params).clientId};return Response.json(clientScrapSummarySchema.parse(await getClientScrapSummary(client,id)),{headers});});}
