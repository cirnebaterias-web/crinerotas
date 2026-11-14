'use client';
import { useRef,useState } from 'react';
import { recordRouteStopAttemptCommandSchema,routeStopAttemptAttachmentConfirmationSchema,
  routeStopAttemptAttachmentIntentResultSchema,routeStopAttemptAttachmentPath,
  routeStopAttemptAttachmentConfirmPath,routeStopAttemptPath,type CanonicalRoute,
  type RouteStopAttemptReasonCode } from '@cirne/contracts';
import { VisitEvidenceCapture,type VisitEvidenceCaptureValue } from '../visits/visit-evidence-capture';
import { useModalFocus } from './modal-focus';
import type { OfflineFoundationService } from '../../lib/offline/service';

const reasons:ReadonlyArray<[RouteStopAttemptReasonCode,string]>=[['client_closed','Cliente fechado'],['responsible_absent','Responsável ausente'],
  ['client_unavailable','Cliente não pôde atender'],['visit_refused','Recusou a visita'],['reschedule_requested','Solicitou reagendamento'],
  ['access_blocked','Acesso impedido'],['address_not_found','Endereço não localizado'],['business_closed','Encerrou atividades'],['other','Outro']];
const headers=(deviceId:string,key:string)=>({'content-type':'application/json','x-csrf-token':'cirne-route-v1','x-device-id':deviceId,'idempotency-key':key});
async function json(url:string,init:RequestInit){const response=await fetch(url,{...init,credentials:'same-origin',cache:'no-store'});if(!response.ok)throw new Error('request');return response.json() as Promise<unknown>;}
export function NonVisitWizard({stop,deviceId,userId,offlineService,onCancel,onDone}:{stop:CanonicalRoute['stops'][number];deviceId:string;userId?:string;offlineService?:OfflineFoundationService;onCancel():void;onDone(reason:RouteStopAttemptReasonCode):Promise<void>}){
  const modal=useModalFocus(onCancel);
  const[step,setStep]=useState<'reason'|'evidence'|'review'>('reason');const[reason,setReason]=useState<RouteStopAttemptReasonCode|null>(null);
  const[observation,setObservation]=useState('');const[evidence,setEvidence]=useState<VisitEvidenceCaptureValue|null>(null);const[busy,setBusy]=useState(false);
  const[message,setMessage]=useState('Selecione o motivo.');const attemptId=useRef(crypto.randomUUID());const attachmentId=useRef(crypto.randomUUID());const key=useRef(crypto.randomUUID());
  const observationRef=useRef<HTMLTextAreaElement|null>(null);
  const otherInvalid=reason==='other'&&!observation.trim()&&message==='Descreva o outro motivo.';
  function continueReason(){if(!reason){setMessage('Selecione um motivo.');return;}if(reason==='other'&&!observation.trim()){setMessage('Descreva o outro motivo.');queueMicrotask(()=>observationRef.current?.focus());return;}setStep('evidence');}
  async function confirm(){if(!reason||!evidence?.photo||!evidence.location||busy)return;setBusy(true);setMessage('Enviando foto e registrando a parada…');
    try{const expires=new Date(evidence.capturedAt);expires.setUTCDate(expires.getUTCDate()+180);const command=recordRouteStopAttemptCommandSchema.parse({schemaVersion:1,offlineId:attemptId.current,routeVersionStopId:stop.routeVersionStopId,reasonCode:reason,
        ...(observation.trim()?{observation:observation.trim()}:{}),evidence:{attachmentOfflineId:attachmentId.current,latitude:Number(evidence.location.latitude),longitude:Number(evidence.location.longitude),accuracyM:Number(evidence.location.accuracyM),capturedAt:evidence.capturedAt}});
      if(!navigator.onLine&&offlineService&&userId){await offlineService.saveOfflineNonVisit(userId,{...command,attachmentOfflineId:attachmentId.current,checksum:evidence.photo.checksum,expiresAt:expires.toISOString()},evidence.photo.blob);await onDone(reason);return;}
      const intent=routeStopAttemptAttachmentIntentResultSchema.parse(await json(routeStopAttemptAttachmentPath,{method:'POST',headers:headers(deviceId,key.current),body:JSON.stringify({schemaVersion:1,offlineId:attachmentId.current,attemptOfflineId:attemptId.current,contentType:evidence.photo.contentType,byteSize:evidence.photo.blob.size,checksum:evidence.photo.checksum,capturedAt:evidence.capturedAt,expiresAt:expires.toISOString()})}));
      const uploadUrl=new URL(intent.signedUrl);if(!uploadUrl.searchParams.has('token'))uploadUrl.searchParams.set('token',intent.token);const form=new FormData();form.append('cacheControl','3600');form.append('',evidence.photo.blob);
      const uploaded=await fetch(uploadUrl,{method:'PUT',credentials:'omit',headers:{'x-upsert':'false'},body:form});if(!uploaded.ok&&uploaded.status!==409)throw new Error('upload');
      routeStopAttemptAttachmentConfirmationSchema.parse(await json(routeStopAttemptAttachmentConfirmPath(attachmentId.current),{method:'POST',headers:headers(deviceId,crypto.randomUUID()),body:JSON.stringify({schemaVersion:1,checksum:evidence.photo.checksum})}));
      await json(routeStopAttemptPath(stop.routeVersionStopId),{method:'POST',headers:headers(deviceId,crypto.randomUUID()),body:JSON.stringify(command)});await onDone(reason);
    }catch{setMessage('Não foi possível confirmar. A foto e o motivo foram preservados nesta tela para tentar novamente.');setBusy(false);}}
  if(step==='evidence')return <div className="seller-evidence-overlay"><VisitEvidenceCapture kind="attempt" client={stop.client} busy={busy} onCancel={()=>setStep('reason')} onConfirm={async(value)=>{setEvidence(value);setStep('review');}}/></div>;
  return <div className="seller-evidence-overlay"><section ref={modal.dialogRef} onKeyDown={modal.onKeyDown} className="seller-stock-card non-visit-wizard" role="dialog" aria-modal="true" aria-labelledby="non-visit-title">
    <p className="seller-kicker">PARADA NÃO REALIZADA</p><h2 id="non-visit-title">{step==='reason'?'Por que a visita não aconteceu?':'Revise antes de confirmar'}</h2><p><strong>{stop.client.name}</strong></p>
    {step==='reason'?<><fieldset><legend>Motivo</legend><div className="non-visit-reasons">{reasons.map(([code,label],index)=><label key={code}><input autoFocus={index===0} type="radio" name="reason" checked={reason===code} onChange={()=>{setReason(code);setMessage('Selecione o motivo.');}}/>{label}</label>)}</div></fieldset>
      <label htmlFor="non-visit-observation">{reason==='other'?'Outro motivo (obrigatório)':'Observação complementar (opcional)'}</label><textarea ref={observationRef} id="non-visit-observation" maxLength={500} value={observation} aria-invalid={otherInvalid} aria-describedby={otherInvalid?'non-visit-error':undefined} onChange={(event)=>setObservation(event.target.value)}/>{otherInvalid&&<p id="non-visit-error" role="alert">Descreva o outro motivo.</p>}</>
      :<><p>Motivo: <strong>{reasons.find(([code])=>code===reason)?.[1]}</strong></p>{observation&&<p>Observação: {observation}</p>}<p>GPS: {evidence?.location?.latitude}, {evidence?.location?.longitude} · precisão {evidence?.location?.accuracyM} m</p>
        <p className="seller-notice">Isso registrará a parada como não realizada; uma visita não será iniciada.</p></>}
    <p role="status">{message}</p><div className="seller-evidence-actions"><button className="seller-button seller-secondary" type="button" disabled={busy} onClick={step==='reason'?onCancel:()=>setStep('evidence')}>{step==='reason'?'Cancelar':'Refazer evidência'}</button>
      <button className="seller-button seller-primary" type="button" disabled={busy||!reason} onClick={()=>step==='reason'?continueReason():void confirm()}>{step==='reason'?'Continuar':'Confirmar não realizada'}</button></div>
  </section></div>;
}
