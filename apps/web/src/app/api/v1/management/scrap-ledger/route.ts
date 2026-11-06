import { handleClientImportRequest } from '@/server/client-imports/http';
import { RouteRequestError } from '@/server/routes/http';
import { getScrapLedgerAnalytics } from '@/server/scrap-ledger-sync/service';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(request:Request){return handleClientImportRequest(request,'/api/v1/management/scrap-ledger',async({identity,client},headers)=>{if(!identity.capabilities.includes('scrap_ledger.sync'))throw new RouteRequestError(403,'FORBIDDEN','Operação não autorizada.',false);const url=new URL(request.url);const view=url.searchParams.get('view')??'balances';const search=url.searchParams.get('search')??'';const page=Number(url.searchParams.get('page')??'1');return Response.json(await getScrapLedgerAnalytics(client,view,search,page),{headers});});}
