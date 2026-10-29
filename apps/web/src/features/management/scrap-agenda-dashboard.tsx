'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiErrorResponseSchema,
  scrapAgendaFilterSchema,
  scrapAgendaPath,
  scrapAgendaResponseSchema,
  type PickupSchedule,
  type ScrapAgendaFilter,
  type ScrapAgendaResponse,
} from '@cirne/contracts';
import { ScrapShell } from '../scrap/scrap-ui';
import { PickupScheduleRevisionForm } from './pickup-schedule-revision-form';

export type ScrapAgendaInitialState =
  | { kind: 'ready' | 'empty'; filters: ScrapAgendaFilter; result: ScrapAgendaResponse }
  | { kind: 'forbidden' | 'recoverable_error'; filters: ScrapAgendaFilter; message: string };

function localDateTime(value: string | null, operationalTimeZone: string) {
  return value
    ? new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short', timeStyle: 'short', timeZone: operationalTimeZone,
    }).format(new Date(value))
    : 'Sem confirmação no período';
}

function filterUrl(filters: ScrapAgendaFilter, cursor = false) {
  const query = new URLSearchParams({ from: filters.from, to: filters.to, status: 'pending' });
  for (const key of ['period', 'sellerId', 'clientId'] as const) {
    if (filters[key]) query.set(key, filters[key]);
  }
  if (cursor && filters.cursor) query.set('cursor', filters.cursor);
  return query;
}

function ScheduleCard({
  schedule,
  revising,
  busy,
  operationalTimeZone,
  onRevise,
  onCancel,
  onDone,
}: {
  schedule: PickupSchedule;
  revising: boolean;
  busy: boolean;
  operationalTimeZone: string;
  onRevise(): void;
  onCancel(): void;
  onDone(): Promise<void>;
}) {
  return <article className="field-intelligence-card">
    <header><h3>{schedule.client.name}</h3><p>{schedule.seller.displayName} · {schedule.origin === 'visit' ? 'Durante visita' : 'Fora da rota'}</p></header>
    <p>{schedule.client.address}</p>
    <p><strong>{schedule.estimatedWeightKg} kg estimados</strong> · {schedule.desiredDate} · {schedule.period === 'morning' ? 'Manhã' : 'Tarde'}</p>
    <p><strong>Estado:</strong> Pendente · versão {schedule.version}</p>
    <p>{schedule.observation ?? 'Sem observação'}</p>
    <p>Solicitado em {localDateTime(schedule.requestedAt, operationalTimeZone)} · confirmado no servidor em {localDateTime(schedule.serverSavedAt, operationalTimeZone)}</p>
    {revising
      ? <PickupScheduleRevisionForm schedule={schedule} onCancel={onCancel} onDone={onDone} />
      : <button type="button" className="seller-button seller-secondary" disabled={busy} onClick={onRevise}>Revisar agendamento</button>}
  </article>;
}

export function ScrapAgendaDashboard({
  initial,
  operationalTimeZone,
}: {
  initial: ScrapAgendaInitialState;
  operationalTimeZone: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial.filters);
  const [confirmed, setConfirmed] = useState(initial.kind === 'ready' || initial.kind === 'empty' ? initial.result : null);
  const [state, setState] = useState<'ready' | 'empty' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(initial.kind === 'forbidden' || initial.kind === 'recoverable_error' ? initial.message : '');
  const [revising, setRevising] = useState('');
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus(); }, [state]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const parsed = scrapAgendaFilterSchema.safeParse({
      ...draft,
      status: 'pending',
      period: draft.period || undefined,
      sellerId: draft.sellerId || undefined,
      clientId: draft.clientId || undefined,
      cursor: undefined,
    });
    if (!parsed.success) {
      setState('recoverable_error');
      setMessage(parsed.error.issues[0]?.message ?? 'Revise os filtros informados.');
      return;
    }
    router.push(`/management/scrap/agenda?${filterUrl(parsed.data).toString()}`);
  }

  async function fetchResult(filters: ScrapAgendaFilter) {
    const url = new URL(scrapAgendaPath, window.location.origin);
    url.search = filterUrl(filters, true).toString();
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const failure = apiErrorResponseSchema.safeParse(body);
      if ([401, 403].includes(response.status)) {
        setConfirmed(null); setState('forbidden'); setMessage('Seu perfil não tem acesso à agenda de sucata.');
        return null;
      }
      throw new Error(failure.success ? failure.data.error.message : 'Não foi possível atualizar a agenda.');
    }
    return scrapAgendaResponseSchema.parse(body);
  }

  async function refresh() {
    setState('loading'); setMessage('');
    try {
      const result = await fetchResult(confirmed?.filters ?? initial.filters);
      if (!result) return false;
      setConfirmed(result); setRevising(''); setState(result.records.length === 0 ? 'empty' : 'ready');
      return true;
    } catch (error) {
      setState('recoverable_error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar a agenda.');
      return false;
    }
  }

  async function loadMore() {
    if (!confirmed?.nextCursor) return;
    setState('loading');
    try {
      const result = await fetchResult({ ...confirmed.filters, cursor: confirmed.nextCursor });
      if (!result) return;
      setConfirmed({ ...result, records: [...confirmed.records, ...result.records] });
      setState('ready');
    } catch (error) {
      setState('recoverable_error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a próxima página.');
    }
  }

  return <ScrapShell><main className="field-intelligence-page">
    <p className="seller-kicker">GESTÃO · AGENDA DE SUCATA</p><h1>Pendências confirmadas</h1>
    <nav className="field-intelligence-tabs" aria-label="Gestão de sucata"><Link href="/management/scrap">Coletas e recebimentos</Link><Link href="/management/scrap/agenda" aria-current="page">Agenda pendente</Link></nav>
    <form className="field-intelligence-filters" onSubmit={applyFilters}>
      <label>Data desejada inicial<input type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>Data desejada final<input type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>Período<select value={draft.period ?? ''} onChange={(event) => setDraft({ ...draft, period: (event.target.value || undefined) as ScrapAgendaFilter['period'] })}><option value="">Todos</option><option value="morning">Manhã</option><option value="afternoon">Tarde</option></select></label>
      <label>Vendedor (ID)<input value={draft.sellerId ?? ''} onChange={(event) => setDraft({ ...draft, sellerId: event.target.value || undefined })} /></label>
      <label>Cliente (ID)<input value={draft.clientId ?? ''} onChange={(event) => setDraft({ ...draft, clientId: event.target.value || undefined })} /></label>
      <label>Estado<input value="Pendente" disabled aria-describedby="agenda-state-note" /></label>
      <p id="agenda-state-note">Outros estados dependem da definição de responsável e SLA.</p>
      <div className="field-intelligence-actions"><button className="seller-button seller-primary">Aplicar filtros</button><button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void refresh()}>{state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}</button></div>
    </form>
    {state === 'loading' && <p role="status" aria-live="polite">Atualizando pendências confirmadas…</p>}
    {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}><strong>{state === 'forbidden' ? 'Acesso não autorizado.' : 'Atualização não concluída.'}</strong><p>{message}</p>{state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}</div>}
    {confirmed && <><section className="field-intelligence-summary" aria-label="Indicadores da agenda"><article><span>Pendências</span><strong>{confirmed.indicators.records}</strong></article><article><span>Kg estimados</span><strong>{confirmed.indicators.scheduledKg}</strong></article></section><p className="manager-day-updated">Última confirmação no servidor: <strong>{localDateTime(confirmed.lastServerConfirmedAt, operationalTimeZone)}</strong></p><p className="seller-notice">{confirmed.serverVisibilityNote}</p>{message && (state === 'ready' || state === 'empty') && <p role="status" className="seller-notice">{message}</p>}{confirmed.records.length === 0 ? <section className="seller-state" aria-live="polite"><h2>Nenhuma pendência confirmada</h2><p>Ajuste o período ou os filtros e tente novamente.</p></section> : <section aria-labelledby="agenda-records-title"><h2 id="agenda-records-title">Agendamentos pendentes</h2><div className="field-intelligence-records">{confirmed.records.map((schedule) => <ScheduleCard key={schedule.id} schedule={schedule} revising={revising === schedule.id} busy={state === 'loading'} operationalTimeZone={operationalTimeZone} onRevise={() => { setRevising(schedule.id); setMessage(''); }} onCancel={() => setRevising('')} onDone={async () => { if (await refresh()) setMessage('Revisão confirmada no servidor. O agendamento continua pendente.'); }} />)}</div></section>}{confirmed.nextCursor && <button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void loadMore()}>Carregar mais</button>}</>}
  </main></ScrapShell>;
}
