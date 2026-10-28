'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  apiErrorResponseSchema,
  attachmentDownloadUrlResponseSchema,
  visitDetailPath,
  visitDetailResponseSchema,
  type VisitDetailResponse,
} from '@cirne/contracts';
import { ScrapShell } from '../scrap/scrap-ui';

export type VisitDetailInitialState =
  | { kind: 'ready'; result: VisitDetailResponse }
  | { kind: 'forbidden' | 'recoverable_error'; visitId: string; message: string };

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Não informado';
}

function sectionState(state: string) {
  if (state === 'absent') return 'Não informado';
  if (state === 'withheld') return 'Oculto por permissão';
  if (state === 'unknown_to_server') return 'Não conhecido pelo servidor';
  return 'Disponível';
}

const synchronizationStatusLabel: Record<VisitDetailResponse['synchronization']['status'], string> = {
  confirmed: 'Confirmada',
  recoverable_error: 'Erro recuperável',
  action_required: 'Ação necessária',
};

function EvidenceList({ evidence }: { evidence: VisitDetailResponse['evidence'] }) {
  const [message, setMessage] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  if (evidence.state !== 'available') return <p>{sectionState(evidence.state)}</p>;

  async function openEvidence(attachmentId: string, path: string) {
    const popup = window.open('', '_blank');
    if (!popup) {
      setMessage('Permita pop-ups para abrir a evidência temporária.');
      return;
    }
    popup.opener = null;
    setLoadingId(attachmentId);
    setMessage('');
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = apiErrorResponseSchema.safeParse(body);
        throw new Error(failure.success ? failure.data.error.message : 'Não foi possível emitir o acesso temporário.');
      }
      const result = attachmentDownloadUrlResponseSchema.parse(body);
      if (popup.closed) throw new Error('A janela da evidência foi fechada; tente novamente.');
      popup.location.assign(result.url);
      setMessage('Acesso temporário emitido por até 60 segundos.');
    } catch (error) {
      popup.close();
      setMessage(error instanceof Error ? error.message : 'O acesso temporário expirou ou está indisponível.');
    } finally {
      setLoadingId(null);
    }
  }

  return <>
    {evidence.items.length === 0 ? <p>Nenhuma evidência verificada.</p> : <ul>{evidence.items.map((item) => <li key={item.id}>
      <span>{item.purpose.replaceAll('_', ' ')} · {dateTime(item.capturedAt)}</span>{' '}
      <button className="seller-button seller-secondary" type="button" disabled={loadingId !== null}
        onClick={() => void openEvidence(item.id, item.downloadUrlPath)}>
        {loadingId === item.id ? 'Emitindo…' : 'Abrir por 60 s'}
      </button>
    </li>)}</ul>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </>;
}

export function VisitDetailDashboard({ initial }: { initial: VisitDetailInitialState }) {
  const [confirmed, setConfirmed] = useState(initial.kind === 'ready' ? initial.result : null);
  const [state, setState] = useState<'ready' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(initial.kind === 'ready' ? '' : initial.message);
  const alertRef = useRef<HTMLDivElement>(null);
  const visitId = confirmed?.visitId ?? (initial.kind === 'ready' ? initial.result.visitId : initial.visitId);

  useEffect(() => {
    if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus();
  }, [state]);

  async function refresh() {
    setState('loading');
    setMessage('');
    try {
      const response = await fetch(visitDetailPath(visitId), { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setConfirmed(null); setState('forbidden'); setMessage('A visita não foi encontrada no seu escopo.'); return;
        }
        const failure = apiErrorResponseSchema.safeParse(body);
        throw new Error(failure.success ? failure.data.error.message : 'Não foi possível atualizar o detalhe.');
      }
      setConfirmed(visitDetailResponseSchema.parse(body));
      setState('ready');
    } catch (error) {
      setState('recoverable_error');
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar o detalhe.');
    }
  }

  return <ScrapShell><main className="manager-day-page visit-detail-page">
    <p className="seller-kicker">GESTÃO COMERCIAL · DETALHE DA VISITA</p>
    <Link href="/management/day">← Voltar à visão do dia</Link>
    <h1>{confirmed?.context.client.name ?? 'Detalhe da visita'}</h1>
    <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()} disabled={state === 'loading'}>
      {state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}
    </button>
    {state === 'loading' && <p role="status" aria-live="polite">Atualizando o último detalhe confirmado…</p>}
    {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}>
      <strong>{state === 'forbidden' ? 'Visita indisponível.' : 'Atualização não concluída.'}</strong><p>{message}</p>
      {state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}
    </div>}

    {confirmed && <>
      <p className="seller-notice">{confirmed.serverVisibilityNote}</p>
      <section className="manager-day-route" aria-labelledby="visit-context-title"><h2 id="visit-context-title">Contexto preservado</h2>
        <dl className="manager-day-counts">
          <div><dt>Data operacional</dt><dd>{confirmed.context.serviceDate}</dd></div>
          <div><dt>Vendedor</dt><dd>{confirmed.context.seller.displayName}</dd></div>
          <div><dt>Rota</dt><dd>Versão {confirmed.context.route.versionNumber}, parada {confirmed.context.stop.plannedOrder}</dd></div>
          <div><dt>Situação</dt><dd>{confirmed.status === 'completed' ? 'Concluída' : 'Em andamento'}</dd></div>
          <div><dt>Início no aparelho</dt><dd>{dateTime(confirmed.deviceStartedAt)}</dd></div>
          <div><dt>Recebida pelo servidor</dt><dd>{dateTime(confirmed.serverStartedAt)}</dd></div>
        </dl>
      </section>

      <section className="manager-day-route"><h2>Estoque</h2><p>{sectionState(confirmed.sections.stock.state)}</p>
        {confirmed.sections.stock.state === 'available' && <><p>Heliar: {confirmed.sections.stock.heliarQuantity} · Moura: {confirmed.sections.stock.mouraQuantity}</p>
          {confirmed.sections.stock.observation && <p>{confirmed.sections.stock.observation}</p>}</>}
      </section>
      <section className="manager-day-route"><h2>Preços da concorrência</h2><p>{sectionState(confirmed.sections.competitorPrices.state)}</p>
        {confirmed.sections.competitorPrices.state === 'available' && (confirmed.sections.competitorPrices.availability === 'unavailable'
          ? <p>Coleta não ocorreu: {confirmed.sections.competitorPrices.unavailableReason?.label ?? 'motivo preservado'}</p>
          : <ul>{confirmed.sections.competitorPrices.quotations.map((quote) => <li key={quote.id}>{quote.competitor.label} · {quote.modelOrAmperage} · R$ {quote.priceBrl}</li>)}</ul>)}
      </section>
      <section className="manager-day-route"><h2>Ações comerciais</h2><p>{sectionState(confirmed.sections.commercialActions.state)}</p>
        {confirmed.sections.commercialActions.state === 'available' && <p>{confirmed.sections.commercialActions.competitor.availability === 'identified' ? 'Ações concorrentes identificadas.' : 'Não ocorreu identificação de ação concorrente.'}</p>}
      </section>
      <section className="manager-day-route"><h2>Sucata</h2><p>{sectionState(confirmed.sections.scrap.state)}</p>
        {confirmed.sections.scrap.state === 'available' && <dl className="manager-day-counts">
          <div><dt>Kg coletados</dt><dd>{confirmed.sections.scrap.collectedWeightKg ?? 'Não ocorreu'}</dd></div>
          <div><dt>Kg agendados</dt><dd>{confirmed.sections.scrap.scheduledWeightKg ?? 'Não ocorreu'}</dd></div>
        </dl>}
      </section>
      <section className="manager-day-route"><h2>Resultado e sincronização</h2>
        <p>{confirmed.sections.result.state === 'available' ? `Concluída em ${dateTime(confirmed.serverCompletedAt)}` : 'Resultado não informado.'}</p>
        <p>Estado conhecido: {synchronizationStatusLabel[confirmed.synchronization.status]} · {confirmed.synchronization.attemptCount} tentativa(s).</p>
      </section>
      <section className="manager-day-route"><h2>Exceções operacionais</h2>{confirmed.exceptions.length === 0 ? <p>Não ocorreu exceção conhecida.</p> : <ul>{confirmed.exceptions.map((item) => <li key={`${item.kind}:${item.capturedAt}`}>{item.message} · {dateTime(item.capturedAt)}</li>)}</ul>}</section>
      <section className="manager-day-route"><h2>Localização</h2><p>{sectionState(confirmed.location.state)}</p>
        {confirmed.location.state === 'available' && <dl className="manager-day-counts"><div><dt>Latitude</dt><dd>{confirmed.location.latitude}</dd></div><div><dt>Longitude</dt><dd>{confirmed.location.longitude}</dd></div><div><dt>Precisão (m)</dt><dd>{confirmed.location.accuracyM ?? 'Não informada'}</dd></div></dl>}
      </section>
      <section className="manager-day-route"><h2>Evidências</h2><EvidenceList evidence={confirmed.evidence} /></section>
      <section className="manager-day-route"><h2>Histórico sanitizado</h2>{confirmed.timeline.length === 0 ? <p>Nenhum evento de histórico disponível.</p> : <ol>{confirmed.timeline.map((event, index) => <li key={`${event.occurredAt}:${event.action}:${index}`}>{event.action} · {dateTime(event.occurredAt)}</li>)}</ol>}</section>
    </>}
  </main></ScrapShell>;
}
