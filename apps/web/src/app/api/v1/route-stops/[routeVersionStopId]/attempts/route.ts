import { recordRouteStopAttemptCommandSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { requireMutationHeaders,requireSeller,requireUuid } from '@/server/field-outcomes/http';
import { recordStopAttempt } from '@/server/field-outcomes/service';
import { readRouteJson,RouteRequestError } from '@/server/routes/http';
type Context={params:Promise<{routeVersionStopId:string}>};export const runtime='nodejs';export const dynamic='force-dynamic';
export function POST(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/route-stops/{routeVersionStopId}/attempts',async({identity,client},headers)=>{
  requireSeller(identity,'route.attempt_self');const stopId=requireUuid((await context.params).routeVersionStopId,'Parada');const parsed=recordRouteStopAttemptCommandSchema.safeParse(await readRouteJson(request));
  if(!parsed.success||parsed.data.routeVersionStopId!==stopId)throw new RouteRequestError(422,'VALIDATION_FAILED','Revise motivo, foto e GPS.',false);
  const mutation=requireMutationHeaders(request);return Response.json(await recordStopAttempt(client,mutation.deviceId,mutation.idempotencyKey,parsed.data),{status:201,headers});});}
