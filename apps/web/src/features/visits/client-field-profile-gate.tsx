'use client';
import { useEffect, useRef, useState } from 'react';
import type { ClientClassificationCode, ClientClassificationCode as Code } from '@cirne/contracts';
import { sellerClient } from '../../lib/seller-client';
import type { OfflineFoundationService } from '../../lib/offline/service';

type Catalog = Awaited<ReturnType<typeof sellerClient.classificationCatalog>>['values'];
export function ClientFieldProfileGate({ clientId, clientName, deviceId, userId, offlineService, onReady }: {
  clientId:string;clientName:string;deviceId:string;userId?:string;offlineService?:OfflineFoundationService;onReady():void;
}) {
  const [catalog,setCatalog]=useState<Catalog>([]);const[selected,setSelected]=useState<ClientClassificationCode|null>(null);
  const [loading,setLoading]=useState(true);const[message,setMessage]=useState('Consultando cadastro do cliente…');
  const [showClose,setShowClose]=useState(false);const[reason,setReason]=useState('Encerrou as atividades');const[observation,setObservation]=useState('');
  const key=useRef<string|null>(null);
  useEffect(()=>{let active=true;Promise.all([sellerClient.clientFieldProfile(clientId),sellerClient.classificationCatalog()]).then(([profile,list])=>{
    if(!active)return;setCatalog(list.values);if(profile.operatingStatus==='closed'){setMessage('Este cliente está marcado como encerrado.');return;}
    if(profile.classificationId){onReady();return;}setMessage('Escolha a opção que melhor descreve este cliente.');
  }).catch(async()=>{if(offlineService&&userId&&await offlineService.hasPendingOfflineClassification(userId,clientId)){onReady();return;}setMessage('Não foi possível consultar a classificação. Verifique a conexão e tente novamente.');}).finally(()=>active&&setLoading(false));return()=>{active=false;};},[clientId,offlineService,onReady,userId]);
  async function save(){if(!selected||loading)return;setLoading(true);const idempotencyKey=key.current??crypto.randomUUID();key.current=idempotencyKey;
    try{if(!navigator.onLine&&offlineService&&userId)await offlineService.saveOfflineClassification(userId,clientId,selected);else await sellerClient.classifyClient(clientId,selected,deviceId,idempotencyKey);key.current=null;onReady();}
    catch{setMessage('A classificação não foi confirmada. Atualize o cadastro e tente novamente.');setLoading(false);}}
  async function close(){if(!reason.trim()||loading)return;setLoading(true);const idempotencyKey=key.current??crypto.randomUUID();key.current=idempotencyKey;
    try{await sellerClient.closeClient(clientId,reason,observation,deviceId,idempotencyKey);key.current=null;setMessage('Cliente marcado como encerrado. Volte à rota.');setShowClose(false);}
    catch{setMessage('Não foi possível confirmar o encerramento.');setLoading(false);}}
  return <section className="seller-stock-card client-classification-gate" aria-labelledby="classification-title" aria-busy={loading}>
    <p className="seller-kicker">CADASTRO DO CLIENTE</p><h2 id="classification-title">Classifique este cliente</h2><p><strong>{clientName}</strong></p><p role="status">{message}</p>
    {!loading&&catalog.length>0&&<fieldset><legend>Tipo de estabelecimento</legend><div className="classification-options">{catalog.map((item)=><label key={item.code}>
      <input type="radio" name="classification" value={item.code} checked={selected===item.code} onChange={()=>setSelected(item.code as Code)}/><span><strong>{item.label}</strong><small>{item.description}</small></span></label>)}</div></fieldset>}
    {!showClose?<div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary is-danger" disabled={loading} onClick={()=>setShowClose(true)}>Cliente encerrou as atividades</button>
      <button type="button" className="seller-button seller-primary" disabled={loading||!selected} onClick={()=>void save()}>Salvar classificação</button></div>
      :<div className="client-close-confirm"><h3>Confirmar encerramento?</h3><p>O cliente sairá das próximas rotas, mas o histórico será preservado.</p>
        <label>Motivo<input value={reason} maxLength={120} onChange={(event)=>setReason(event.target.value)}/></label><label>Observação (opcional)<textarea value={observation} maxLength={500} onChange={(event)=>setObservation(event.target.value)}/></label>
        <div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary" onClick={()=>setShowClose(false)}>Cancelar</button><button type="button" className="seller-button seller-primary is-danger" disabled={!reason.trim()||loading} onClick={()=>void close()}>Marcar como encerrado</button></div></div>}
  </section>;
}
