import { reserveRouteStopAttemptAttachmentCommandSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { reserveAttemptEvidence } from '@/server/field-outcomes/evidence';
import { requireMutationHeaders,requireSeller } from '@/server/field-outcomes/http';
import { readRouteJson,RouteRequestError } from '@/server/routes/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
export function POST(request:Request){return handleClientImportRequest(request,'/api/v1/route-stop-attempt-attachments',async({identity,client},headers)=>{
  requireSeller(identity,'route.attempt_self');const parsed=reserveRouteStopAttemptAttachmentCommandSchema.safeParse(await readRouteJson(request));
  if(!parsed.success)throw new RouteRequestError(422,'VALIDATION_FAILED','A foto informada é inválida.',false);const mutation=requireMutationHeaders(request);
  return Response.json(await reserveAttemptEvidence(client,mutation.deviceId,mutation.idempotencyKey,parsed.data),{status:201,headers});});}
