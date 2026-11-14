'use client';
import { useEffect, useRef, useState } from 'react';
import type { CanonicalRoute, SellerRouteClient } from '@cirne/contracts';
import { sellerClient } from '../../lib/seller-client';
import { useModalFocus } from './modal-focus';

export function AdditionalClientDialog({ route, deviceId, onClose, onAdded }: {
  route: CanonicalRoute; deviceId: string; onClose(): void; onAdded(): Promise<void>;
}) {
  const modal=useModalFocus(onClose);
  const [query,setQuery]=useState(''); const [clients,setClients]=useState<SellerRouteClient[]>([]);
  const [selected,setSelected]=useState<SellerRouteClient|null>(null); const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('Digite nome, referência ou endereço.'); const key=useRef<string|null>(null);
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{
    setBusy(true);sellerClient.searchRouteClients(route.routeId,query,controller.signal).then((result)=>{
      setClients(result.clients);setMessage(result.clients.length?'Selecione o cliente adicional.':'Nenhum cliente elegível encontrado.');
    }).catch(()=>{if(!controller.signal.aborted)setMessage('Não foi possível buscar sua carteira.');}).finally(()=>setBusy(false));
  },250);return()=>{clearTimeout(timer);controller.abort();};},[query,route.routeId]);
  async function confirm(){if(!selected||selected.alreadyOnRoute||busy)return;setBusy(true);setMessage('Incluindo cliente no fim da rota…');
    const idempotencyKey=key.current??crypto.randomUUID();key.current=idempotencyKey;
    try{await sellerClient.addRouteClient(route,selected.id,deviceId,idempotencyKey);key.current=null;setMessage(`${selected.name} foi incluído no fim da rota.`);await onAdded();}
    catch{setMessage('A rota mudou ou a inclusão não foi confirmada. Atualize a rota e tente novamente.');}finally{setBusy(false);}}
  return <div className="seller-evidence-overlay"><section ref={modal.dialogRef} onKeyDown={modal.onKeyDown} className="seller-stock-card additional-client-dialog" role="dialog" aria-modal="true" aria-labelledby="additional-client-title">
    <p className="seller-kicker">ROTA DE HOJE</p><h2 id="additional-client-title">Adicionar cliente</h2>
    <p>Somente clientes ativos da sua carteira. O cliente será incluído no fim da rota.</p>
    <label>Buscar cliente<input autoFocus type="search" value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Nome, referência ou endereço" /></label>
    <p role="status">{busy?'Buscando…':message}</p><ul className="additional-client-results">{clients.map((client)=><li key={client.id}>
      <button type="button" disabled={client.alreadyOnRoute||busy} aria-pressed={selected?.id===client.id} onClick={()=>setSelected(client)}>
        <strong>{client.name}</strong><span>{client.address}</span><small>{client.alreadyOnRoute?'Já está na rota':client.externalReference}</small>
      </button></li>)}</ul>
    <div className="seller-evidence-actions"><button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onClose}>Cancelar</button>
      <button type="button" className="seller-button seller-primary" disabled={!selected||selected.alreadyOnRoute||busy} onClick={()=>void confirm()}>Confirmar inclusão</button></div>
  </section></div>;
}
