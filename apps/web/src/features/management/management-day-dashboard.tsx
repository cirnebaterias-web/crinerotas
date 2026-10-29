'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  apiErrorResponseSchema, managementDayPath, managementDayResponseSchema, managementServiceDateSchema,
  type ManagementActivityState, type ManagementDayResponse, type ManagementDayRouteV2,
} from '@cirne/contracts';
import {
  filterManagementRoutes, managementAttentionQueue, resolvedStopCount, routeClosureLabel, routeDailyState,
} from './management-day-model';
import { ReportExportActions } from './report-export-actions';
import { ManagementMapPanel } from './management-map-panel';
import type { ManagementMapPublicConfig } from '@cirne/config/server';

export type ManagementDayInitialState =
  | { kind: 'ready' | 'empty'; serviceDate: string; result: ManagementDayResponse }
  | { kind: 'forbidden' | 'recoverable_error'; serviceDate: string; message: string };

const statusLabel = {
  pending: 'Pendente', in_visit: 'Em visita', completed: 'Concluída', not_visited: 'Não visitada',
} as const;
const activityLabel: Record<ManagementActivityState, string> = {
  confirmed: 'Confirmado', not_occurred: 'Não ocorreu', exception: 'Com exceção',
  unknown_to_server: 'Ainda não recebido', withheld: 'Acesso restrito', action_required: 'Ação necessária',
};
const checklistLabel = {
  facadeCheckin: 'Foto da fachada / check-in', checkout: 'Foto de saída', stock: 'Estoque',
  competitorPrices: 'Preços da concorrência', commercialActions: 'Ações comerciais',
  scrap: 'Sucata', result: 'Resultado da visita', synchronization: 'Sincronização',
} as const;

function localDateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Sem atualização conhecida';
}

function activityStateLabel(state: ManagementActivityState, visitStatus: 'in_progress' | 'completed') {
  return state === 'not_occurred' && visitStatus === 'in_progress' ? 'Ainda não ocorreu' : activityLabel[state];
}

function LegacyRoutes({ result }: { result: Extract<ManagementDayResponse, { schemaVersion: 1 }> }) {
  return <section aria-labelledby="manager-routes-title"><h2 id="manager-routes-title">Rotas por vendedor</h2>
    <p className="seller-notice">A fonte ainda respondeu no formato anterior. Atualize após aplicar a migração da central operacional.</p>
    <div className="manager-day-routes">{result.routes.map((route) => <article className="manager-day-route" key={route.routeId}>
      <header><div><h3>{route.seller.displayName}</h3><p>Rota versão {route.versionNumber}</p></div><p>Atualizada em {localDateTime(route.lastKnownUpdateAt)}</p></header>
      <dl className="manager-day-counts"><div><dt>Planejadas</dt><dd>{route.counts.planned}</dd></div><div><dt>Pendentes</dt><dd>{route.counts.pending}</dd></div><div><dt>Em visita</dt><dd>{route.counts.inVisit}</dd></div><div><dt>Concluídas</dt><dd>{route.counts.completed}</dd></div><div><dt>Não visitadas</dt><dd>{route.counts.notVisited}</dd></div></dl>
      {route.visits.length > 0 && <ul>{route.visits.map((visit) => <li key={visit.visitId}><Link href={`/management/visits/${visit.visitId}`}>{visit.client.name}</Link> · {visit.status === 'completed' ? 'Concluída' : 'Em andamento'}</li>)}</ul>}
    </article>)}</div>
  </section>;
}

function StopInspector({ route, selectedStopId, selectedVisitId, open, onSelect, onSelectVisit, onClose }: {
  route: ManagementDayRouteV2;
  selectedStopId: string | null;
  selectedVisitId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onSelectVisit: (id: string) => void;
  onClose: () => void;
}) {
  const selectedIndex = Math.max(0, route.stops.findIndex((stop) => stop.routeVersionStopId === selectedStopId));
  const stop = route.stops[selectedIndex];
  if (!stop) return <aside className="management-inspector"><h2>Atividades da rota</h2><p>Nenhuma parada disponível.</p></aside>;
  const visit = stop.visits.find((item) => item.visitId === selectedVisitId) ?? stop.visits.at(-1);
  return <aside className="management-inspector" aria-labelledby="inspector-title" data-open={open} tabIndex={-1}>
    <button type="button" className="management-inspector-close" onClick={onClose} aria-label="Fechar atividades">Fechar ×</button>
    <header><div><p className="seller-kicker">PARADA {selectedIndex + 1} DE {route.stops.length}</p><h2 id="inspector-title">{stop.client.name}</h2></div>
      <span className={`management-status status-${stop.status}`}>{statusLabel[stop.status]}</span></header>
    <p className="management-inspector-seller">Vendedor: <strong>{route.seller.displayName}</strong></p>
    <div className="management-inspector-nav">
      <button type="button" disabled={selectedIndex === 0} onClick={() => onSelect(route.stops[selectedIndex - 1]!.routeVersionStopId)}>← Anterior</button>
      <button type="button" disabled={selectedIndex === route.stops.length - 1} onClick={() => onSelect(route.stops[selectedIndex + 1]!.routeVersionStopId)}>Próxima →</button>
    </div>
    <p className="management-stop-meta">Ordem planejada {stop.plannedOrder} · execução {stop.executionOrder} · atualização {localDateTime(stop.lastKnownUpdateAt)}</p>
    {(route.sync.errors > 0 || route.sync.pending > 0) && <p className="seller-notice"><strong>Sincronização da rota:</strong> {route.sync.errors} erro(s) e {route.sync.pending} envio(s) pendente(s). O estado abaixo se refere somente à visita selecionada.</p>}
    {stop.nonVisitReason && <p className="seller-notice"><strong>Motivo da não visita:</strong> {stop.nonVisitReason.label}</p>}
    {!visit ? <section className="management-checklist-empty"><h3>Atividades</h3><p>Nenhuma visita recebida pelo servidor para esta parada.</p></section>
      : <>{stop.visits.length > 1 && <section className="management-visit-picker"><h3>{stop.visits.length} visitas registradas</h3><div>
        {stop.visits.map((item, index) => <button type="button" key={item.visitId} aria-pressed={item.visitId === visit.visitId} onClick={() => onSelectVisit(item.visitId)}>
          Visita {index + 1} · {item.status === 'completed' ? 'Concluída' : 'Em andamento'} · {localDateTime(item.serverStartedAt)}
        </button>)}
      </div></section>}
      <section><h3>Situação das atividades no servidor</h3><ul className="management-checklist">
        {Object.entries(visit.checklist).map(([key, state]) => <li key={key} data-state={state}>
          <span>{checklistLabel[key as keyof typeof checklistLabel]}</span><strong>{activityStateLabel(state, visit.status)}</strong>
        </li>)}
      </ul></section>
      {visit.exceptionCount > 0 && <p className="seller-notice">{visit.exceptionCount} exceção(ões) registrada(s) nesta visita.</p>}
      <Link className="seller-button seller-primary management-detail-link" href={`/management/visits/${visit.visitId}`}>Abrir detalhe completo</Link></>}
    <section className="management-stop-index" aria-label="Paradas da rota"><h3>Todas as paradas</h3><ol>
      {route.stops.map((item) => <li key={item.routeVersionStopId}><button type="button" aria-current={item.routeVersionStopId === stop.routeVersionStopId ? 'step' : undefined} onClick={() => onSelect(item.routeVersionStopId)}>
        <span>{item.executionOrder}. {item.client.name}</span><small>{statusLabel[item.status]}</small>
      </button></li>)}
    </ol></section>
  </aside>;
}

export function ManagementDayDashboard({ initial, mapConfig = { enabled: false, reason: 'unconfigured' } }: {
  initial: ManagementDayInitialState;
  mapConfig?: ManagementMapPublicConfig;
}) {
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(initial.serviceDate);
  const [confirmed, setConfirmed] = useState(initial.kind === 'ready' || initial.kind === 'empty' ? initial.result : null);
  const [state, setState] = useState<'ready' | 'empty' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(initial.kind === 'forbidden' || initial.kind === 'recoverable_error' ? initial.message : '');
  const [query, setQuery] = useState('');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => { if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus(); }, [state]);
  useEffect(() => {
    if (!inspectorOpen) return;
    window.setTimeout(() => document.querySelector<HTMLElement>('.management-inspector[data-open="true"]')?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setInspectorOpen(false);
      window.setTimeout(() => returnFocusRef.current?.focus(), 0);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [inspectorOpen]);
  const routes = useMemo(() => confirmed?.schemaVersion === 2
    ? filterManagementRoutes(confirmed.routes, query, onlyAttention) : [], [confirmed, query, onlyAttention]);
  const attentionQueue = useMemo(() => confirmed?.schemaVersion === 2
    ? managementAttentionQueue(confirmed.routes) : [], [confirmed]);
  const selectedRoute = routes.find((route) => route.routeId === selectedRouteId) ?? routes[0] ?? null;

  function closeInspector() {
    setInspectorOpen(false);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  function openStop(routeId: string, stopId: string, trigger?: HTMLElement | null) {
    if (trigger) returnFocusRef.current = trigger;
    setSelectedRouteId(routeId);
    setSelectedStopId(stopId);
    setSelectedVisitId(null);
    setInspectorOpen(true);
  }

  function selectRoute(route: ManagementDayRouteV2, event?: MouseEvent<HTMLElement>) {
    const attention = managementAttentionQueue([route])[0];
    const currentStop = route.routeId === selectedRouteId
      ? route.stops.find((stop) => stop.routeVersionStopId === selectedStopId)
      : undefined;
    openStop(route.routeId,
      currentStop?.routeVersionStopId
        ?? (onlyAttention && attention ? attention.stopId : route.stops[0]?.routeVersionStopId ?? ''),
      event?.currentTarget ?? null);
  }

  function updateQuery(value: string) {
    setQuery(value);
    if (!confirmed || confirmed.schemaVersion !== 2 || !value.trim()) return;
    const normalized = value.trim().toLocaleLowerCase('pt-BR');
    const matchingRoute = confirmed.routes.find((route) => (
      route.seller.displayName.toLocaleLowerCase('pt-BR').includes(normalized)
      || route.stops.some((stop) => stop.client.name.toLocaleLowerCase('pt-BR').includes(normalized))
    ));
    if (!matchingRoute) return;
    const matchingStop = matchingRoute.stops.find((stop) => (
      stop.client.name.toLocaleLowerCase('pt-BR').includes(normalized)
    ));
    setSelectedRouteId(matchingRoute.routeId);
    setSelectedStopId(matchingStop?.routeVersionStopId ?? matchingRoute.stops[0]?.routeVersionStopId ?? null);
    setSelectedVisitId(null);
  }

  function selectDate(event: FormEvent) {
    event.preventDefault();
    const parsed = managementServiceDateSchema.safeParse(selectedDate);
    if (!parsed.success) { setState('recoverable_error'); setMessage('Informe uma data válida.'); return; }
    router.push(`/management/day?serviceDate=${encodeURIComponent(parsed.data)}`);
  }

  async function refresh() {
    const parsed = managementServiceDateSchema.safeParse(confirmed?.serviceDate ?? initial.serviceDate);
    if (!parsed.success) return;
    setState('loading'); setMessage('');
    try {
      const url = new URL(managementDayPath, window.location.origin); url.searchParams.set('serviceDate', parsed.data);
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = apiErrorResponseSchema.safeParse(body);
        if (response.status === 401 || response.status === 403) {
          setConfirmed(null); setState('forbidden'); setMessage('Seu perfil não tem acesso à visão gerencial.'); return;
        }
        throw new Error(failure.success ? failure.data.error.message : 'Não foi possível atualizar a visão.');
      }
      const result = managementDayResponseSchema.parse(body);
      setConfirmed(result); setState(result.availability === 'empty' ? 'empty' : 'ready');
    } catch (error) {
      setState('recoverable_error'); setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar a visão.');
    }
  }

  function focusAttention(trigger?: HTMLElement | null) {
    if (attentionQueue.length === 0) return;
    const currentIndex = attentionQueue.findIndex((item) => (
      item.routeId === selectedRouteId && item.stopId === selectedStopId
    ));
    const next = attentionQueue[(currentIndex + 1) % attentionQueue.length]!;
    setQuery('');
    setOnlyAttention(true);
    openStop(next.routeId, next.stopId, trigger);
  }

  return <main className="manager-day-page">
    <div className="management-page-heading"><div><p className="seller-kicker">GESTÃO COMERCIAL · CENTRAL OPERACIONAL</p><h1>Rotas e atividades do dia</h1><p>Acompanhe o avanço dos vendedores e abra cada parada para verificar o que chegou ao servidor.</p></div>
      <button type="button" className="seller-button seller-secondary" disabled={attentionQueue.length === 0} onClick={(event) => focusAttention(event.currentTarget)}>Abrir próxima atenção</button></div>
    <form className="manager-day-controls" onSubmit={selectDate}>
      <label>Data operacional<input type="date" required value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} disabled={state === 'loading'} /></label>
      <button className="seller-button seller-primary" disabled={state === 'loading'}>Aplicar data</button>
      <button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void refresh()}>{state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}</button>
      {confirmed && <ReportExportActions view="management_day" filters={{ serviceDate: confirmed.serviceDate }} disabled={state === 'loading'} />}
    </form>
    {state === 'loading' && <p role="status" aria-live="polite">Atualizando a visão confirmada…</p>}
    {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}><strong>{state === 'forbidden' ? 'Acesso não autorizado.' : 'Atualização não concluída.'}</strong><p>{message}</p>{state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}</div>}

    {confirmed && <>
      <section className="manager-day-summary" aria-label="Indicadores do dia">
        <article><span>Planejadas</span><strong>{confirmed.totals.planned}</strong></article><article><span>Pendentes</span><strong>{confirmed.totals.pending}</strong></article>
        <article><span>Em visita</span><strong>{confirmed.totals.inVisit}</strong></article><article><span>Concluídas</span><strong>{confirmed.totals.completed}</strong></article>
        <article><span>Não visitadas</span><strong>{confirmed.totals.notVisited}</strong></article><article><span>Pendências de envio</span><strong>{confirmed.sync.pending}</strong></article>
        <article className="management-summary-attention"><span>Requer atenção</span><strong>{attentionQueue.length}</strong></article>
      </section>
      <div className="management-freshness"><p>Última atualização conhecida: <strong>{localDateTime(confirmed.lastKnownUpdateAt)}</strong></p><p>{confirmed.serverVisibilityNote}</p></div>
      <ManagementMapPanel key={`${confirmed.serviceDate}:${confirmed.generatedAt}`}
        serviceDate={confirmed.serviceDate} config={mapConfig} />
      {confirmed.availability === 'empty' ? <section className="seller-state" aria-live="polite"><h2>Nenhuma rota publicada nesta data</h2><p>Selecione outra data ou atualize após a publicação das rotas.</p></section>
        : confirmed.schemaVersion === 1 ? <LegacyRoutes result={confirmed} />
          : <><section className="management-local-filters" aria-label="Filtros locais"><label>Buscar vendedor ou cliente<input type="search" value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Digite um nome" /></label><label className="management-attention-toggle"><input type="checkbox" checked={onlyAttention} onChange={(event) => {
            const checked = event.target.checked; setOnlyAttention(checked);
            if (checked && attentionQueue[0]) openStop(attentionQueue[0].routeId, attentionQueue[0].stopId, event.currentTarget);
          }} />Somente requer atenção</label></section>
            {attentionQueue.length > 0 && <section className="management-attention-queue" aria-labelledby="attention-title"><div className="management-section-title"><div><h2 id="attention-title">Requer atenção</h2><p>Ordem sugerida pelos fatos confirmados no servidor.</p></div><span>{attentionQueue.length} {attentionQueue.length === 1 ? 'item' : 'itens'}</span></div><ol>
              {attentionQueue.map((item) => <li key={item.id}><button type="button" data-selected={item.routeId === selectedRouteId && item.stopId === selectedStopId} onClick={(event) => {
                setQuery(''); setOnlyAttention(true); openStop(item.routeId, item.stopId, event.currentTarget);
              }}><strong>{item.reason}</strong><span>{item.sellerName} · {item.clientName}</span></button></li>)}
            </ol></section>}
            <div className="management-command-grid"><section className="management-route-table" aria-labelledby="routes-table-title"><div className="management-section-title"><h2 id="routes-table-title">Vendedores e rotas</h2><span>{routes.length} {routes.length === 1 ? 'exibida' : 'exibidas'}</span></div>
              <div className="management-table-scroll"><table><caption className="seller-sr-only">Situação das rotas por vendedor</caption><thead><tr><th>Vendedor</th><th>Progresso</th><th>Execução</th><th>Em aberto</th><th>Sync</th><th>Fechamento</th><th>Atualização</th></tr></thead><tbody>
                {routes.map((route) => { const dailyState = routeDailyState(route); return <tr key={route.routeId} data-selected={selectedRoute?.routeId === route.routeId}><td><button type="button" onClick={(event) => selectRoute(route, event)}><strong>{route.seller.displayName}</strong><small>Rota v{route.versionNumber}</small></button></td><td><strong>{resolvedStopCount(route)} de {route.counts.planned}</strong><small>resolvidas / planejadas</small></td><td><strong>{route.counts.completed} concluídas · {route.counts.notVisited} não visitadas</strong></td><td><strong>{route.counts.pending} pendentes · {route.counts.inVisit} em visita</strong></td><td><strong>{route.sync.pending + route.sync.errors}</strong><small>{route.sync.errors} exigem ação</small></td><td><span className={`management-route-state state-${dailyState}`}>{routeClosureLabel(route)}</span></td><td>{localDateTime(route.lastKnownUpdateAt)}</td></tr>; })}
              </tbody></table></div><div className="management-route-cards" aria-label="Rotas por vendedor em formato compacto">{routes.map((route) => <article key={route.routeId}><div><strong>{route.seller.displayName}</strong><span>{routeClosureLabel(route)}</span></div><dl><div><dt>Progresso</dt><dd>{resolvedStopCount(route)} de {route.counts.planned}</dd></div><div><dt>Em aberto</dt><dd>{route.counts.pending + route.counts.inVisit}</dd></div><div><dt>Atenção</dt><dd>{managementAttentionQueue([route]).length}</dd></div></dl><button type="button" className="seller-button seller-secondary" onClick={(event) => selectRoute(route, event)}>Ver atividades</button></article>)}</div>{routes.length === 0 && <p className="seller-state">Nenhuma rota corresponde aos filtros locais.</p>}</section>
              {selectedRoute && <><button type="button" className="management-inspector-backdrop" aria-label="Fechar atividades" data-open={inspectorOpen} onClick={closeInspector} /><StopInspector route={selectedRoute} selectedStopId={selectedStopId} selectedVisitId={selectedVisitId} open={inspectorOpen} onSelect={(id) => { setSelectedStopId(id); setSelectedVisitId(null); }} onSelectVisit={setSelectedVisitId} onClose={closeInspector} /></>}
            </div></>}
    </>}
  </main>;
}
