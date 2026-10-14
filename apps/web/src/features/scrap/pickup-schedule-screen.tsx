'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { type ScrapClient, type PickupScheduleInput } from '@cirne/contracts';
import { StandaloneScrapScheduleStore } from '@/lib/offline/standalone-scrap';
import type { LocalStandaloneScrapSchedule } from '@/lib/offline/database';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { PickupScheduleForm } from './pickup-schedule-form';
import { ScrapShell } from './scrap-ui';

export function PickupScheduleScreen() {
  const [query, setQuery] = useState(''); const [clients, setClients] = useState<ScrapClient[]>([]); const [client, setClient] = useState<ScrapClient | null>(null);
  const [error, setError] = useState(''); const [savedId, setSavedId] = useState(''); const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<LocalStandaloneScrapSchedule[]>([]); const [offline, setOffline] = useState(false);
  const store = useRef<StandaloneScrapScheduleStore | null>(null); const allowed = useRef(false);
  useEffect(() => {
    const current = new StandaloneScrapScheduleStore(); store.current = current; allowed.current = true;
    let mounted = true;
    const ready = () => mounted && allowed.current;
    const resume = async () => {
      if (!ready()) return;
      setOffline(!navigator.onLine);
      try {
        const local = await current.listSchedules(); if (ready()) setRecords(local);
        const updated = await current.synchronize(); if (ready()) setRecords(updated);
      } catch (failure) { if (ready()) setError(failure instanceof Error ? failure.message : 'Não foi possível restaurar os agendamentos.'); }
    };
    const revoked = observeLocalAccessRevocation(() => { allowed.current = false; setRecords([]); setClients([]); setClient(null); setSavedId(''); setError('Entre novamente para acessar seus agendamentos.'); });
    const connectivity = () => { setOffline(!navigator.onLine); if (navigator.onLine) void resume(); };
    const foreground = () => { if (document.visibilityState === 'visible') void resume(); };
    void resume(); window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity); document.addEventListener('visibilitychange', foreground);
    return () => { mounted = false; allowed.current = false; revoked(); current.close(); if (store.current === current) store.current = null; window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); document.removeEventListener('visibilitychange', foreground); };
  }, []);
  async function search(event: FormEvent) { event.preventDefault(); if (busy || !allowed.current || !store.current) return; setBusy(true); setError(''); try { const found = await store.current.searchClients(query); if (allowed.current) setClients(found); } catch (failure) { if (allowed.current) setError(failure instanceof Error ? failure.message : 'Não foi possível buscar clientes.'); } finally { setBusy(false); } }
  async function save(value: PickupScheduleInput) {
    if (!client || !store.current || !allowed.current) throw new Error('Selecione o cliente e valide seu acesso.');
    setBusy(true);
    try {
      const record = await store.current.enqueue(client, value);
      if (!allowed.current) return;
      setSavedId(record.offlineId); setRecords((previous) => [record, ...previous.filter((item) => item.offlineId !== record.offlineId)]);
      try { const updated = await store.current.synchronize(); if (allowed.current) setRecords(updated); }
      catch (failure) { if (allowed.current) setError(failure instanceof Error ? failure.message : 'O agendamento está salvo no aparelho; envio pendente.'); }
    }
    finally { setBusy(false); }
  }
  async function retry() { if (!store.current || !allowed.current || busy) return; setBusy(true); setError(''); try { const updated = await store.current.synchronize(); if (allowed.current) setRecords(updated); } catch (failure) { if (allowed.current) setError(failure instanceof Error ? failure.message : 'Os agendamentos permanecem salvos no aparelho.'); } finally { setBusy(false); } }
  const saved = records.find((record) => record.offlineId === savedId);
  const statusLabel = (record: LocalStandaloneScrapSchedule) => record.status === 'synced' ? 'Confirmado no servidor' : record.status === 'action_required' ? 'Salvo no aparelho · requer conferência' : 'Salvo no aparelho · envio pendente';
  return <ScrapShell><p className="seller-kicker">FORA DA ROTA</p><h1>Agendar coleta de sucata</h1>
    <p className="seller-muted" role="status">{offline ? 'Sem conexão. Busque clientes já consultados neste aparelho e salve para enviar depois.' : 'Clientes da base autorizada · agendamentos preservados neste aparelho.'}</p>
    {error && <p role="alert" className="seller-notice seller-error">{error}</p>}
    {saved ? <section className="seller-progress" role="status"><h2>{statusLabel(saved)}</h2><p>{saved.client.name} · {saved.client.address}</p><p>{saved.request.desiredDate} · {saved.request.period === 'morning' ? 'Manhã' : 'Tarde'} · {saved.request.estimatedWeightKg} kg previstos</p><a className="seller-button seller-primary" href="/home">Voltar ao início</a><button className="seller-button seller-secondary" disabled={busy} onClick={() => { setSavedId(''); setClient(null); setError(''); }}>Novo agendamento</button></section> : <>
      <form onSubmit={search}><label>Buscar cliente<input value={query} maxLength={120} disabled={busy} onChange={(e) => setQuery(e.target.value)} /></label><button className="seller-button seller-secondary" disabled={busy}>{busy ? 'Aguarde…' : 'Buscar na base de clientes'}</button></form>
      <ul className="seller-stop-list">{clients.map((item) => <li key={item.id}><button type="button" className="seller-task-card" disabled={busy} aria-pressed={client?.id === item.id} onClick={() => setClient(item)}><span><strong>{item.name}</strong><small>{item.address}</small></span><span>{client?.id === item.id ? 'Selecionado' : 'Selecionar'}</span></button></li>)}</ul>
      {client && <section className="seller-stock-card"><h2>{client.name}</h2><p>Endereço da base: {client.address}</p><PickupScheduleForm key={client.id} onSave={save} /></section>}
    </>}
    <section aria-label="Agendamentos salvos neste aparelho"><h2>Meus agendamentos salvos</h2><button className="seller-button seller-secondary" disabled={busy || offline} onClick={() => void retry()}>{busy ? 'Sincronizando…' : 'Tentar sincronizar'}</button>
      {records.length === 0 && <p>Nenhum agendamento salvo neste aparelho.</p>}
      {records.map((record) => <article className="seller-stock-card" key={record.offlineId}><h3>{record.client.name}</h3><p>{record.client.address}</p><p>{record.request.desiredDate} · {record.request.period === 'morning' ? 'Manhã' : 'Tarde'} · {record.request.estimatedWeightKg} kg previstos</p><p>{statusLabel(record)}</p>{record.lastError && <p className="seller-notice">{record.lastError}</p>}{record.serverSavedAt && <p>Confirmado em {new Date(record.serverSavedAt).toLocaleString('pt-BR')}</p>}</article>)}
    </section>
  </ScrapShell>;
}
