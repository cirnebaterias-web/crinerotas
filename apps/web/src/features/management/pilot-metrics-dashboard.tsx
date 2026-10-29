'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiErrorResponseSchema, pilotMetricsFilterSchema, pilotMetricsPath, pilotMetricsResponseSchema,
  type PilotMetricsFilter, type PilotMetricsResponse,
} from '@cirne/contracts';
import { ScrapShell } from '../scrap/scrap-ui';

export type PilotMetricsInitialState =
  | { kind: 'ready' | 'empty'; filters: PilotMetricsFilter; result: PilotMetricsResponse }
  | { kind: 'forbidden' | 'recoverable_error'; filters: PilotMetricsFilter; message: string };

const assessmentLabels = {
  provisional_met: 'Meta provisoriamente atendida',
  provisional_not_met: 'Meta provisoriamente não atendida',
  not_evaluable: 'Não avaliável',
} as const;
const syncLabels = {
  within_24h: 'Dentro de 24 h', outside_24h: 'Fora de 24 h',
  window_open: 'Janela aberta', clock_suspicious: 'Relógio suspeito',
} as const;

function query(filters: PilotMetricsFilter, withCursor = false) {
  const value = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.sellerId) value.set('sellerId', filters.sellerId);
  if (filters.clientId) value.set('clientId', filters.clientId);
  if (withCursor && filters.cursor) value.set('cursor', filters.cursor);
  return value;
}
function localDateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
    : 'Sem confirmação no período';
}

export function PilotMetricsDashboard({ initial }: { initial: PilotMetricsInitialState }) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial.filters);
  const [confirmed, setConfirmed] = useState(initial.kind === 'ready' || initial.kind === 'empty' ? initial.result : null);
  const [state, setState] = useState<'ready' | 'empty' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(initial.kind === 'forbidden' || initial.kind === 'recoverable_error' ? initial.message : '');
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus(); }, [state]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const parsed = pilotMetricsFilterSchema.safeParse({
      ...draft, sellerId: draft.sellerId || undefined, clientId: draft.clientId || undefined, cursor: undefined,
    });
    if (!parsed.success) {
      setState('recoverable_error'); setMessage(parsed.error.issues[0]?.message ?? 'Revise os filtros informados.'); return;
    }
    router.push(`/management/pilot?${query(parsed.data).toString()}`);
  }
  async function fetchResult(filters: PilotMetricsFilter) {
    const url = new URL(pilotMetricsPath, window.location.origin); url.search = query(filters, true).toString();
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const failure = apiErrorResponseSchema.safeParse(body);
      if ([401, 403].includes(response.status)) {
        setConfirmed(null); setState('forbidden'); setMessage('Seu perfil não tem acesso às métricas do piloto.'); return null;
      }
      throw new Error(failure.success ? failure.data.error.message : 'Não foi possível atualizar as métricas.');
    }
    return pilotMetricsResponseSchema.parse(body);
  }
  async function refresh() {
    setState('loading'); setMessage('');
    try {
      const result = await fetchResult(confirmed?.filters ?? initial.filters); if (!result) return;
      setConfirmed(result);
      setState(result.metrics.some((metric) => (metric.observation?.denominator ?? 0) > 0) ? 'ready' : 'empty');
    } catch (error) {
      setState('recoverable_error'); setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar as métricas.');
    }
  }
  async function loadMore() {
    if (!confirmed?.nextCursor) return;
    setState('loading');
    try {
      const result = await fetchResult({ ...confirmed.filters, cursor: confirmed.nextCursor }); if (!result) return;
      setConfirmed({ ...result, records: [...confirmed.records, ...result.records] }); setState('ready');
    } catch (error) {
      setState('recoverable_error'); setMessage(error instanceof Error ? error.message : 'Não foi possível carregar mais exceções.');
    }
  }

  return <ScrapShell><main className="field-intelligence-page">
    <p className="seller-kicker">GESTÃO COMERCIAL · AVALIAÇÃO DO PILOTO</p><h1>Métricas canônicas do piloto</h1>
    <nav className="field-intelligence-tabs" aria-label="Gestão comercial"><Link href="/management/day">Visão do dia</Link><Link href="/management/intelligence">Inteligência de campo</Link><Link href="/management/pilot" aria-current="page">Métricas do piloto</Link></nav>
    <form className="field-intelligence-filters" onSubmit={applyFilters}>
      <label>Data inicial<input type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>Data final<input type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>Vendedor (ID)<input value={draft.sellerId ?? ''} onChange={(event) => setDraft({ ...draft, sellerId: event.target.value || undefined })} /></label>
      <label>Cliente (ID)<input value={draft.clientId ?? ''} onChange={(event) => setDraft({ ...draft, clientId: event.target.value || undefined })} /></label>
      <div className="field-intelligence-actions"><button className="seller-button seller-primary">Aplicar filtros</button><button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void refresh()}>{state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}</button></div>
    </form>
    {state === 'loading' && <p role="status" aria-live="polite">Atualizando métricas confirmadas…</p>}
    {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}><strong>{state === 'forbidden' ? 'Acesso não autorizado.' : 'Atualização não concluída.'}</strong><p>{message}</p>{state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}</div>}
    {confirmed && <><p className="manager-day-updated">Última confirmação server-side: <strong>{localDateTime(confirmed.lastServerConfirmedAt)}</strong></p><p className="seller-notice">{confirmed.serverVisibilityNote}</p>
      <section className="field-intelligence-records" aria-label="Nove métricas do piloto">{confirmed.metrics.map((metric) => <article className="field-intelligence-card" key={metric.id}><header><p>{metric.id}</p><h2>{metric.name}</h2></header><p><strong>{assessmentLabels[metric.assessment]}</strong></p>{metric.observation ? metric.observation.denominator > 0 ? <p><strong>{metric.observation.percentage}%</strong> · {metric.observation.numerator} de {metric.observation.denominator}</p> : <p>Sem denominador confirmado no período.</p> : <p>Fonte necessária: {metric.requiredSource}</p>}<p>Meta: {metric.target.operator === 'gte' ? '≥' : '='} {metric.target.value}{metric.target.unit === 'percent' ? '%' : ''}</p><p>{metric.note}</p></article>)}</section>
      {confirmed.records.length > 0 && <section aria-labelledby="pilot-exceptions"><h2 id="pilot-exceptions">Exceções para investigação</h2><div className="field-intelligence-records">{confirmed.records.map((record) => <article className="field-intelligence-card" key={record.visitId}><header><h3>{record.client.name}</h3><p>{record.seller.displayName} · {record.serviceDate}</p></header><ul><li>Etapas obrigatórias: {record.checks.requiredComplete ? 'completas' : 'incompletas'}</li><li>Sucata: {record.checks.scrapReported ? 'informada' : 'ausente'}</li><li>Ação concorrente: {record.checks.commercialActionReported ? 'informada' : 'ausente'}</li><li>Sincronização: {syncLabels[record.checks.sync24h]}</li></ul></article>)}</div></section>}
      {confirmed.nextCursor && <button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void loadMore()}>Carregar mais exceções</button>}
    </>}
  </main></ScrapShell>;
}
