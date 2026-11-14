import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readEvidenceConfig } from '@cirne/config/server';
import { routeStopAttemptAttachmentConfirmationSchema, routeStopAttemptAttachmentIntentResultSchema,
  type ReserveRouteStopAttemptAttachmentCommand } from '@cirne/contracts';
import { createEvidenceVerifierClient } from '../evidence-verifier';
import { RouteRequestError } from '../routes/http';
import { fieldOutcomeRpc } from './service';

function signatureMatches(bytes:Uint8Array,type:string){return type==='image/jpeg'
  ? bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff
  : type==='image/webp'&&new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';}

export async function reserveAttemptEvidence(client:SupabaseClient,deviceId:string,key:string,command:ReserveRouteStopAttemptAttachmentCommand){
  const reserved=await fieldOutcomeRpc(client,'reserve_route_stop_attempt_attachment',{p_device_id:deviceId,p_idempotency_key:key,p_command:command}) as Record<string,unknown>;
  const storagePath=String(reserved.storagePath??'');const bucket=readEvidenceConfig(process.env).EVIDENCE_STORAGE_BUCKET;
  const signed=await client.storage.from(bucket).createSignedUploadUrl(storagePath);
  if(signed.error||!signed.data?.signedUrl||!signed.data.token)throw new RouteRequestError(503,'DEPENDENCY_UNAVAILABLE','Não foi possível preparar o envio da foto.',true);
  return routeStopAttemptAttachmentIntentResultSchema.parse({schemaVersion:1,attachmentId:reserved.attachmentId,offlineId:reserved.offlineId,storagePath,
    signedUrl:signed.data.signedUrl,token:signed.data.token,expiresInSeconds:600,alreadyVerified:reserved.status==='verified',
    ...(typeof reserved.verifiedAt==='string'?{verifiedAt:reserved.verifiedAt}:{})});
}

export async function confirmAttemptEvidence(client:SupabaseClient,sellerId:string,deviceId:string,key:string,offlineId:string,checksum:string){
  const metadata=await fieldOutcomeRpc(client,'get_route_stop_attempt_attachment_for_confirmation',{p_device_id:deviceId,p_offline_id:offlineId}) as Record<string,unknown>;
  const response=await client.storage.from(readEvidenceConfig(process.env).EVIDENCE_STORAGE_BUCKET).download(String(metadata.storagePath));
  if(response.error||!response.data||response.data.size>2*1024*1024)throw new RouteRequestError(422,'VALIDATION_FAILED','A foto enviada é inválida.',false);
  const bytes=new Uint8Array(await response.data.arrayBuffer());const type=String(metadata.contentType);const digest=createHash('sha256').update(bytes).digest('hex');
  if(bytes.byteLength!==metadata.byteSize||!signatureMatches(bytes,type)||digest!==checksum||digest!==metadata.checksum)
    throw new RouteRequestError(422,'VALIDATION_FAILED','A foto enviada não corresponde ao arquivo capturado.',false);
  const verifier=await createEvidenceVerifierClient();
  return routeStopAttemptAttachmentConfirmationSchema.parse(await fieldOutcomeRpc(verifier,'verify_route_stop_attempt_attachment',{
    p_seller_id:sellerId,p_device_id:deviceId,p_idempotency_key:key,p_offline_id:offlineId,p_checksum:checksum}));
}
