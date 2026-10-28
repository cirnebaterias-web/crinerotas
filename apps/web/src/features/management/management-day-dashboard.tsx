'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  apiErrorResponseSchema,
  managementDayPath,
  managementDayResponseSchema,
  managementServiceDateSchema,
  type ManagementDayResponse,
} from '@cirne/contracts';
import { ScrapShell } from '../scrap/scrap-ui';

export type ManagementDayInitialState =
  | { kind: 'ready' | 'empty'; serviceDate: string; result: ManagementDayResponse }
  | { kind: 'forbidden' | 'recoverable_error'; serviceDate: string; message: string };

const statusLabel = {
  pending: 'Pendente', in_visit: 'Em visita', completed: 'Concluída', not_visited: 'Não visitada',
} as const;

function localDateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Sem atualização conhecida';
}

export function ManagementDayDashboard({ initial }: { initial: ManagementDayInitialState }) {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(initial.serviceDate);
  const [confirmed, setConfirmed] = useState(
    initial.kind === 'ready' || initial.kind === 'empty' ? initial.result : null,
  );
  const [state, setState] = useState<'ready' | 'empty' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(
    initial.kind === 'forbidden' || initial.kind === 'recoverable_error' ? initial.message : '',
  );
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus();
  }, [state]);

  function selectDate(event: FormEvent) {
    event.preventDefault();
    const parsed = managementServiceDateSchema.safeParse(selectedDate);
    if (!parsed.success) {
      setState('recoverable_error');
      setMessage('Informe uma data válida no formato dia, mês e ano.');
      return;
    }
    router.push(`/management/day?serviceDate=${encodeURIComponent(parsed.data)}`);
  }

  async function refresh() {
    const parsed = managementServiceDateSchema.safeParse(confirmed?.serviceDate ?? initial.serviceDate);
    if (!parsed.success) return;
    setState('loading');
    setMessage('');
    try {
      const url = new URL(managementDayPath, window.location.origin);
      url.searchParams.set('serviceDate', parsed.data);
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = apiErrorResponseSchema.safeParse(body);
        const publicMessage = failure.success ? failure.data.error.message : 'Não foi possível atualizar a visão.';
        if (response.status === 401 || response.status === 403) {
          setConfirmed(null);
          setState('forbidden');
          setMessage('Seu perfil não tem acesso à visão gerencial.');
          return;
        }
        throw new Error(publicMessage);
      }
      const result = managementDayResponseSchema.parse(body);
      setConfirmed(result);
      setState(result.availability === 'empty' ? 'empty' : 'ready');
    } catch (error) {
      setState('recoverable_error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar a visão.');
    }
  }

  return <ScrapShell>
    <div className="manager-day-page">
      <p className="seller-kicker">GESTÃO COMERCIAL · VISÃO DO DIA</p>
      <h1>Acompanhamento das rotas</h1>
      <form className="manager-day-controls" onSubmit={selectDate}>
        <label>Data operacional<input type="date" required value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} disabled={state === 'loading'} /></label>
        <button className="seller-button seller-primary" disabled={state === 'loading'}>Aplicar data</button>
        <button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void refresh()}>{state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}</button>
      </form>

      {state === 'loading' && <p role="status" aria-live="polite">Atualizando a visão confirmada…</p>}
      {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}>
        <strong>{state === 'forbidden' ? 'Acesso não autorizado.' : 'Atualização não concluída.'}</strong>
        <p>{message}</p>
        {state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}
      </div>}

      {confirmed && <>
        <section className="manager-day-summary" aria-label="Indicadores do dia">
          <article><span>Planejadas</span><strong>{confirmed.totals.planned}</strong></article>
          <article><span>Pendentes</span><strong>{confirmed.totals.pending}</strong></article>
          <article><span>Em visita</span><strong>{confirmed.totals.inVisit}</strong></article>
          <article><span>Concluídas</span><strong>{confirmed.totals.completed}</strong></article>
          <article><span>Não visitadas</span><strong>{confirmed.totals.notVisited}</strong></article>
          <article><span>Pendências de envio</span><strong>{confirmed.sync.pending}</strong></article>
          <article><span>Ação necessária</span><strong>{confirmed.sync.errors}</strong></article>
        </section>
        <p className="manager-day-updated">Última atualização conhecida: <strong>{localDateTime(confirmed.lastKnownUpdateAt)}</strong></p>
        <p className="seller-notice">{confirmed.serverVisibilityNote}</p>
        {confirmed.availability === 'empty' ? <section className="seller-state" aria-live="polite"><h2>Nenhuma rota publicada nesta data</h2><p>Selecione outra data ou atualize após a publicação das rotas.</p></section>
          : <section aria-labelledby="manager-routes-title"><h2 id="manager-routes-title">Rotas por vendedor</h2><div className="manager-day-routes">{confirmed.routes.map((route) => <article className="manager-day-route" key={route.routeId}>
            <header><div><h3>{route.seller.displayName}</h3><p>Rota versão {route.versionNumber}</p></div><p>Atualizada em {localDateTime(route.lastKnownUpdateAt)}</p></header>
            <dl className="manager-day-counts"><div><dt>Planejadas</dt><dd>{route.counts.planned}</dd></div><div><dt>Pendentes</dt><dd>{route.counts.pending}</dd></div><div><dt>Em visita</dt><dd>{route.counts.inVisit}</dd></div><div><dt>Concluídas</dt><dd>{route.counts.completed}</dd></div><div><dt>Não visitadas</dt><dd>{route.counts.notVisited}</dd></div></dl>
            {route.visits.length > 0 && <section><h4>Visitas conhecidas pelo servidor</h4><ul>{route.visits.map((visit) => <li key={visit.visitId}>
              <Link href={`/management/visits/${visit.visitId}`}><strong>{visit.client.name}</strong></Link> · {visit.status === 'completed' ? 'Concluída' : 'Em andamento'} · iniciada em {localDateTime(visit.serverStartedAt)}
            </li>)}</ul></section>}
            {route.nonVisits.length > 0 && <section><h4>Motivos de não visita</h4><ul>{route.nonVisits.map((item) => <li key={item.routeVersionStopId}><strong>{item.clientName}</strong> · motivo registrado sob referência {item.reasonId}</li>)}</ul></section>}
            {route.historicalExecutions.length > 0 && <section><h4>Execuções preservadas de versões anteriores</h4><ul>{route.historicalExecutions.map((item) => <li key={item.routeVersionStopId}><strong>{item.clientName}</strong> · {statusLabel[item.status]} · não compõe o total planejado atual</li>)}</ul></section>}
            {route.syncIssues.length > 0 && <section><h4>Sincronização conhecida pelo servidor</h4><ul>{route.syncIssues.map((issue) => <li key={issue.eventId}><strong>{issue.status === 'recoverable_error' ? 'Recuperável' : 'Ação necessária'}</strong> · código {issue.errorCode} · observado em {localDateTime(issue.lastObservedAt)}</li>)}</ul></section>}
          </article>)}</div></section>}
      </>}
    </div>
  </ScrapShell>;
}
