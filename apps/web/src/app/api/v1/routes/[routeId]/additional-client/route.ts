import { extendSellerRouteCommandSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { requireMutationHeaders, requireSeller, requireUuid } from '@/server/field-outcomes/http';
import { extendRoute } from '@/server/field-outcomes/service';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
type Context={params:Promise<{routeId:string}>};export const runtime='nodejs';export const dynamic='force-dynamic';
export function POST(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/routes/{routeId}/additional-client',async({identity,client},headers)=>{
  requireSeller(identity,'route.extend_self');const routeId=requireUuid((await context.params).routeId,'Rota');
  const parsed=extendSellerRouteCommandSchema.safeParse(await readRouteJson(request));
  if(!parsed.success||parsed.data.routeId!==routeId)throw new RouteRequestError(422,'VALIDATION_FAILED','Revise o cliente e a versão da rota.',false);
  const mutation=requireMutationHeaders(request);return Response.json(await extendRoute(client,mutation.deviceId,mutation.idempotencyKey,parsed.data),{headers});});}
