import { routeStopAttemptAttachmentConfirmRequestSchema } from '@cirne/contracts';
import { handleClientImportRequest } from '@/server/client-imports/http';
import { confirmAttemptEvidence } from '@/server/field-outcomes/evidence';
import { requireMutationHeaders,requireSeller,requireUuid } from '@/server/field-outcomes/http';
import { readRouteJson,RouteRequestError } from '@/server/routes/http';
type Context={params:Promise<{offlineId:string}>};export const runtime='nodejs';export const dynamic='force-dynamic';
export function POST(request:Request,context:Context){return handleClientImportRequest(request,'/api/v1/route-stop-attempt-attachments/{offlineId}/confirm',async({identity,client},headers)=>{
  requireSeller(identity,'route.attempt_self');const offlineId=requireUuid((await context.params).offlineId,'Anexo');const parsed=routeStopAttemptAttachmentConfirmRequestSchema.safeParse(await readRouteJson(request));
  if(!parsed.success)throw new RouteRequestError(422,'VALIDATION_FAILED','Checksum inválido.',false);const mutation=requireMutationHeaders(request);
  return Response.json(await confirmAttemptEvidence(client,identity.id,mutation.deviceId,mutation.idempotencyKey,offlineId,parsed.data.checksum),{headers});});}
