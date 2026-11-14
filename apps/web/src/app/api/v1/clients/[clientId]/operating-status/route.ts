import { closeClientCommandSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { closeClient } from '@/server/field-outcomes/service';
import { requireMutationHeaders, requireSeller, requireUuid } from '@/server/field-outcomes/http';
import { readRouteJson, RouteRequestError } from '@/server/routes/http';
type Context={params:Promise<{clientId:string}>}; export const runtime='nodejs'; export const dynamic='force-dynamic';
export function POST(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/clients/{clientId}/operating-status',async({identity,client},headers)=>{
  requireSeller(identity,'client.close_self');const clientId=requireUuid((await context.params).clientId,'Cliente');
  const parsed=closeClientCommandSchema.safeParse(await readRouteJson(request));
  if(!parsed.success||parsed.data.clientId!==clientId)throw new RouteRequestError(422,'VALIDATION_FAILED','Informe o motivo do encerramento.',false);
  const mutation=requireMutationHeaders(request);return Response.json(await closeClient(client,mutation.deviceId,mutation.idempotencyKey,parsed.data),{headers});});}
