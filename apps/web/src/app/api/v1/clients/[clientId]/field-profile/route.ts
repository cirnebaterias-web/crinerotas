import { classifyClientCommandSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { classifyClient, getClientFieldProfile } from '@/server/field-outcomes/service';
import { requireMutationHeaders, requireSeller, requireUuid } from '@/server/field-outcomes/http';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
type Context={params:Promise<{clientId:string}>};
export const runtime='nodejs'; export const dynamic='force-dynamic';
export function GET(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/clients/{clientId}/field-profile',async({identity,client},headers)=>{
  requireSeller(identity,'route.read_self'); return Response.json(await getClientFieldProfile(client,requireUuid((await context.params).clientId,'Cliente')),{headers}); });}
export function POST(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/clients/{clientId}/field-profile',async({identity,client},headers)=>{
  requireSeller(identity,'client.classify_self'); const clientId=requireUuid((await context.params).clientId,'Cliente');
  const parsed=classifyClientCommandSchema.safeParse(await readRouteJson(request));
  if(!parsed.success||parsed.data.clientId!==clientId)throw new RouteRequestError(422,'VALIDATION_FAILED','Selecione uma classificação.',false);
  const mutation=requireMutationHeaders(request); return Response.json(await classifyClient(client,mutation.deviceId,mutation.idempotencyKey,parsed.data),{headers}); });}
