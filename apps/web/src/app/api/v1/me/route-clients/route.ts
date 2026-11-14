import { handleClientImportRequest } from '@/server/client-imports/http';
import { requireSeller, requireUuid } from '@/server/field-outcomes/http';
import { searchRouteClients } from '@/server/field-outcomes/service';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function GET(request:Request){return handleClientImportRequest(request,'/api/v1/me/route-clients',async({identity,client},headers)=>{
  requireSeller(identity,'route.extend_self');const url=new URL(request.url);const routeId=requireUuid(url.searchParams.get('routeId'),'Rota');
  const query=(url.searchParams.get('q')??'').trim().slice(0,160);return Response.json(await searchRouteClients(client,routeId,query),{headers});});}
