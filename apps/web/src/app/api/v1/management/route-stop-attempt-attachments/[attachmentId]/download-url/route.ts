import { readEvidenceConfig } from '@cirne/config/server';
import { resolveVisitRequest, visitErrorResponse, VisitRequestError, visitResponseHeaders } from '@/server/visits/http';
import { createEvidenceVerifierClient } from '@/server/evidence-verifier';

export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{attachmentId:string}>}){const headers=visitResponseHeaders(crypto.randomUUID());
  try{const{attachmentId}=await context.params;const{client}=await resolveVisitRequest(request,headers);const result=await client.schema('api').rpc('get_management_route_stop_attempt_attachment',{p_attachment_id:attachmentId});
    if(result.error||!result.data)throw new VisitRequestError(result.error?.message==='NOT_FOUND'?404:403,result.error?.message==='NOT_FOUND'?'NOT_FOUND':'FORBIDDEN','Foto não encontrada ou acesso não autorizado.',false);
    const metadata=result.data as {storagePath:string;contentType:string};const verifier=await createEvidenceVerifierClient();const signed=await verifier.storage.from(readEvidenceConfig(process.env).EVIDENCE_STORAGE_BUCKET).createSignedUrl(metadata.storagePath,300,{download:false});
    if(signed.error||!signed.data?.signedUrl)throw new VisitRequestError(503,'DEPENDENCY_UNAVAILABLE','Não foi possível abrir a foto.',true);
    return Response.redirect(signed.data.signedUrl,307);
  }catch(error){const failure=error instanceof VisitRequestError?error:new VisitRequestError(503,'DEPENDENCY_UNAVAILABLE','Não foi possível abrir a foto.',true);return visitErrorResponse(failure,headers.get('x-request-id')??crypto.randomUUID(),headers);}}
