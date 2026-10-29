'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  apiErrorResponseSchema, fieldIntelligenceFilterSchema, fieldIntelligencePath,
  fieldIntelligenceResponseSchema, type FieldIntelligenceFilter,
  type FieldIntelligenceResponse, type FieldIntelligenceSection,
} from '@cirne/contracts';
import { ScrapShell } from '../scrap/scrap-ui';

export type FieldIntelligenceInitialState =
  | { kind: 'ready' | 'empty'; filters: FieldIntelligenceFilter; result: FieldIntelligenceResponse }
  | { kind: 'forbidden' | 'recoverable_error'; filters: FieldIntelligenceFilter; message: string };

const sections: { id: FieldIntelligenceSection; label: string }[] = [
  { id: 'stock', label: 'Estoque' }, { id: 'prices', label: 'Preços' },
  { id: 'actions', label: 'Ações' }, { id: 'scrap', label: 'Sucata' },
  { id: 'results', label: 'Resultados' },
];
const actionLabels = {
  differentiated_price: 'Preço diferenciado', seller_or_driver_incentive: 'Incentivo a vendedor/motorista',
  retailer_incentive: 'Incentivo ao varejista', purchase_combo: 'Combo de compra', other: 'Outro',
} as const;

function localDateTime(value: string | null, timeZone?: string) {
  return value ? new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value))
    : 'Sem confirmação no período';
}
function filterUrl(filters: FieldIntelligenceFilter, cursor = false) {
  const query = new URLSearchParams({ section: filters.section, from: filters.from, to: filters.to });
  for (const key of ['sellerId', 'clientId', 'competitorId', 'actionType'] as const) {
    if (filters[key]) query.set(key, filters[key]);
  }
  if (cursor && filters.cursor) query.set('cursor', filters.cursor);
  return query;
}
function indicatorEntries(result: FieldIntelligenceResponse): [string, string | number][] {
  if (result.section === 'stock') return [['Registros', result.indicators.records], ['Heliar', result.indicators.heliarQuantity], ['Moura', result.indicators.mouraQuantity], ['Linha própria', result.indicators.ownLineQuantity], ['Concorrentes', result.indicators.competitorLineQuantity]];
  if (result.section === 'prices') return [['Registros', result.indicators.records], ['Cotações', result.indicators.quotations], ['Indisponíveis', result.indicators.unavailableRecords]];
  if (result.section === 'actions') return [['Registros', result.indicators.records], ['Com ação', result.indicators.identifiedRecords], ['Ações', result.indicators.actions]];
  if (result.section === 'scrap') return [['Registros', result.indicators.records], ['Coletas', result.indicators.collectedRecords], ['Agendamentos', result.indicators.scheduledRecords], ['Kg coletados', result.indicators.collectedWeightKg], ['Kg agendados', result.indicators.scheduledWeightKg]];
  return [['Registros', result.indicators.records], ['Visitas concluídas', result.indicators.completedVisits]];
}

function RecordCards({ result, timeZone }: { result: FieldIntelligenceResponse; timeZone?: string }) {
  if (result.section === 'stock') return <>{result.records.map((record) => <article className="field-intelligence-card" key={record.recordId}>
    <header><h3>{record.client.name}</h3><p>{record.seller.name} · {record.serviceDate}</p></header>
    <p><strong>Heliar:</strong> {record.heliarQuantity} · <strong>Moura:</strong> {record.mouraQuantity}</p>
    {record.ownLines.length > 0 && <><h4>Linha própria</h4><ul>{record.ownLines.map((line, index) => <li key={`${line.productCode ?? line.sku ?? line.model}:${index}`}>{line.brand} · {line.model} · {line.quantity} unidade(s)</li>)}</ul></>}
    {record.competitorLines.length > 0 && <><h4>Linha concorrente</h4><ul>{record.competitorLines.map((line, index) => <li key={`${line.brand}:${line.amperage}:${line.technology}:${index}`}>{line.otherBrand ?? line.brand} · {line.amperage} Ah · {line.technology} · {line.quantity} unidade(s)</li>)}</ul></>}
    {record.ownLines.length === 0 && record.competitorLines.length === 0 && <p>Sem linhas detalhadas neste registro.</p>}
  </article>)}</>;
  if (result.section === 'prices') return <>{result.records.map((record) => <article className="field-intelligence-card" key={record.recordId}>
    <header><h3>{record.client.name}</h3><p>{record.seller.name} · {record.serviceDate}</p></header>
    <p>{record.availability === 'available' ? `${record.quotations.length} cotação(ões)` : `Indisponível: ${record.unavailableReason?.label ?? 'motivo não informado'}`}</p>
    {record.quotations.map((quotation) => <div key={quotation.id}>
      <p><strong>{quotation.competitor.label}</strong> · {quotation.modelOrAmperage} · {quotation.technology.label} · R$ {quotation.priceBrl}</p>
      <p>Condição: {quotation.condition.label}{quotation.observation ? ` · ${quotation.observation}` : ''}</p>
    </div>)}
  </article>)}</>;
  if (result.section === 'actions') return <>{result.records.map((record) => <article className="field-intelligence-card" key={record.recordId}>
    <header><h3>{record.client.name}</h3><p>{record.seller.name} · {record.serviceDate}</p></header>
    {record.actions.length === 0 ? <p>Nenhuma ação identificada.</p> : record.actions.map((action) => <p key={action.id}><strong>{action.competitor.label} · {action.actionType === 'other' ? action.otherType : actionLabels[action.actionType]}</strong> · {action.description} · {action.validFrom} a {action.validUntil}</p>)}
  </article>)}</>;
  if (result.section === 'scrap') return <>{result.records.map((record) => <article className="field-intelligence-card" key={record.recordId}><header><h3>{record.client.name}</h3><p>{record.seller.name} · {record.serviceDate}</p></header>{record.collection && <p><strong>Coletado:</strong> {record.collection.actualWeightKg} kg</p>}{record.schedule && <p><strong>Agendado:</strong> {record.schedule.estimatedWeightKg} kg para {record.schedule.desiredDate}</p>}{!record.collection && !record.schedule && <p>Sem sucata para coleta.</p>}</article>)}</>;
  return <>{result.records.map((record) => <article className="field-intelligence-card" key={record.recordId}><header><h3>{record.client.name}</h3><p>{record.seller.name} · {record.serviceDate}</p></header><p>Visita concluída em {localDateTime(record.serverCompletedAt, timeZone)}.</p></article>)}</>;
}

export function FieldIntelligenceDashboard({ initial, timeZone }: {
  initial: FieldIntelligenceInitialState;
  timeZone?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(initial.filters);
  const [confirmed, setConfirmed] = useState(initial.kind === 'ready' || initial.kind === 'empty' ? initial.result : null);
  const [state, setState] = useState<'ready' | 'empty' | 'loading' | 'recoverable_error' | 'forbidden'>(initial.kind);
  const [message, setMessage] = useState(initial.kind === 'forbidden' || initial.kind === 'recoverable_error' ? initial.message : '');
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state === 'recoverable_error' || state === 'forbidden') alertRef.current?.focus(); }, [state]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    const parsed = fieldIntelligenceFilterSchema.safeParse({ ...draft, competitorId: draft.competitorId || undefined, sellerId: draft.sellerId || undefined, clientId: draft.clientId || undefined, actionType: draft.actionType || undefined, cursor: undefined });
    if (!parsed.success) { setState('recoverable_error'); setMessage(parsed.error.issues[0]?.message ?? 'Revise os filtros informados.'); return; }
    router.push(`/management/intelligence?${filterUrl(parsed.data).toString()}`);
  }
  async function fetchResult(filters: FieldIntelligenceFilter) {
    const url = new URL(fieldIntelligencePath, window.location.origin); url.search = filterUrl(filters, true).toString();
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const failure = apiErrorResponseSchema.safeParse(body);
      if ([401, 403].includes(response.status)) { setConfirmed(null); setState('forbidden'); setMessage('Seu perfil não tem acesso à Inteligência de Campo.'); return null; }
      throw new Error(failure.success ? failure.data.error.message : 'Não foi possível atualizar os dados.');
    }
    return fieldIntelligenceResponseSchema.parse(body);
  }
  async function refresh() {
    setState('loading'); setMessage('');
    try { const result = await fetchResult(confirmed?.filters ?? initial.filters); if (!result) return; setConfirmed(result); setState(result.records.length === 0 ? 'empty' : 'ready'); }
    catch (error) { setState('recoverable_error'); setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar os dados.'); }
  }
  async function loadMore() {
    if (!confirmed?.nextCursor) return;
    setState('loading');
    try {
      const result = await fetchResult({ ...confirmed.filters, cursor: confirmed.nextCursor });
      if (!result || result.section !== confirmed.section) return;
      setConfirmed({ ...result, records: [...confirmed.records, ...result.records] } as FieldIntelligenceResponse); setState('ready');
    } catch (error) { setState('recoverable_error'); setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a próxima página.'); }
  }

  const activeSection = confirmed?.section ?? draft.section;
  return <ScrapShell><main className="field-intelligence-page"><p className="seller-kicker">GESTÃO COMERCIAL · INTELIGÊNCIA DE CAMPO</p><h1>Leituras confirmadas do campo</h1>
    <nav className="field-intelligence-tabs" aria-label="Recortes de inteligência">{sections.map((section) => <Link key={section.id} aria-current={activeSection === section.id ? 'page' : undefined} href={`/management/intelligence?${filterUrl({ ...draft, section: section.id, competitorId: ['prices', 'actions'].includes(section.id) ? draft.competitorId : undefined, actionType: section.id === 'actions' ? draft.actionType : undefined }).toString()}`}>{section.label}</Link>)}</nav>
    <form className="field-intelligence-filters" onSubmit={applyFilters}>
      <label>Data inicial<input type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label><label>Data final<input type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label>Vendedor (ID)<input value={draft.sellerId ?? ''} onChange={(event) => setDraft({ ...draft, sellerId: event.target.value || undefined })} /></label><label>Cliente (ID)<input value={draft.clientId ?? ''} onChange={(event) => setDraft({ ...draft, clientId: event.target.value || undefined })} /></label>
      {['prices', 'actions'].includes(draft.section) && <label>Concorrente (ID)<input value={draft.competitorId ?? ''} onChange={(event) => setDraft({ ...draft, competitorId: event.target.value || undefined })} /></label>}
      {draft.section === 'actions' && <label>Tipo de ação<select value={draft.actionType ?? ''} onChange={(event) => setDraft({ ...draft, actionType: (event.target.value || undefined) as FieldIntelligenceFilter['actionType'] })}><option value="">Todos</option>{Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      <div className="field-intelligence-actions"><button className="seller-button seller-primary">Aplicar filtros</button><button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void refresh()}>{state === 'loading' ? 'Atualizando…' : 'Atualizar agora'}</button></div>
    </form>
    {state === 'loading' && <p role="status" aria-live="polite">Atualizando dados confirmados…</p>}
    {(state === 'recoverable_error' || state === 'forbidden') && <div className="seller-notice seller-error" role="alert" tabIndex={-1} ref={alertRef}><strong>{state === 'forbidden' ? 'Acesso não autorizado.' : 'Atualização não concluída.'}</strong><p>{message}</p>{state === 'recoverable_error' && <button type="button" className="seller-button seller-secondary" onClick={() => void refresh()}>Tentar novamente</button>}</div>}
    {confirmed && <><section className="field-intelligence-summary" aria-label="Indicadores do recorte">{indicatorEntries(confirmed).map(([label, value]) => <article key={label}><span>{label}</span><strong>{value}</strong></article>)}</section><p className="manager-day-updated">Última confirmação no recorte: <strong>{localDateTime(confirmed.lastConfirmedAt, timeZone)}</strong></p><p className="seller-notice">{confirmed.serverVisibilityNote}</p>{confirmed.records.length === 0 ? <section className="seller-state" aria-live="polite"><h2>Nenhum registro confirmado</h2><p>Ajuste o período ou os filtros e tente novamente.</p></section> : <section aria-labelledby="field-records-title"><h2 id="field-records-title">Registros confirmados</h2><div className="field-intelligence-records"><RecordCards result={confirmed} timeZone={timeZone} /></div></section>}{confirmed.nextCursor && <button type="button" className="seller-button seller-secondary" disabled={state === 'loading'} onClick={() => void loadMore()}>Carregar mais</button>}</>}
  </main></ScrapShell>;
}
