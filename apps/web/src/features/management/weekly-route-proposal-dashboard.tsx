'use client';

import { useEffect, useMemo, useState } from 'react';
import { clientListResponseSchema, clientSellerListResponseSchema, clientSellersPath, clientsPath,
  persistedWeeklyRouteProposalSchema, weeklyRoutePlanningResponseSchema,
  weeklyRouteProposalMutationResponseSchema,
  type ImportedClient, type PersistedWeeklyRouteProposal,
  type WeeklyRoutePlanningCandidate, type WeeklyRoutePlanningResponse } from '@cirne/contracts';
import type { ManagementMapPublicConfig } from '@cirne/config/server';
import { approximateDistanceKm, classifyDailyRoute } from '@cirne/domain';
import { WeeklyRoutePlanningMap } from './weekly-route-planning-map';
import { ScrapRequestError, scrapRequest } from '../scrap/scrap-ui';

const endpoint = '/api/v1/management/weekly-route-proposals';
const headers = { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };
const coverageDueStates = new Set(['never_visited', 'overdue', 'due_this_week']);
const exclusionLabels: Record<string, string> = {
  inactive_lost: 'mais de 180 dias sem compra', no_purchase_history: 'sem compra positiva',
  client_not_active: 'cadastro inativo', no_navigable_location: 'sem localização navegável',
  daily_distance_limit: 'distância acima de 30 km entre paradas',
  daily_capacity_reached: 'capacidade semanal ou diária atingida',
  weekly_strategy_mismatch: 'fora da estratégia local/viagem escolhida',
};

function coverageLabel(state: string) {
  const labels: Record<string, string> = { never_visited: 'Sem histórico de visita · visita inicial pendente',
    overdue: 'Rotina de visita atrasada', due_this_week: 'Visita vence nesta semana',
    covered: 'Rotina coberta', unavailable: 'Histórico de visita indisponível' };
  return labels[state] ?? state;
}

function nextMonday() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  const distance = (8 - (date.getDay() || 7)) % 7 || 7;
  date.setDate(date.getDate() + distance);
  return date.toISOString().slice(0, 10);
}

export function WeeklyRouteProposalDashboard({ mapConfig = { enabled: false, reason: 'unconfigured' } }:
  { mapConfig?: ManagementMapPublicConfig }) {
  const [sellers, setSellers] = useState<{ id: string; displayName: string }[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [weekStart, setWeekStart] = useState(nextMonday);
  const [strategyPreference, setStrategyPreference] = useState<'auto' | 'local' | 'trip'>('auto');
  const [record, setRecord] = useState<PersistedWeeklyRouteProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [availableClients, setAvailableClients] = useState<ImportedClient[]>([]);
  const [targetDay, setTargetDay] = useState(0);
  const [planning, setPlanning] = useState<WeeklyRoutePlanningResponse | null>(null);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [savedDaysSignature, setSavedDaysSignature] = useState<string | null>(null);
  const [savedRecord, setSavedRecord] = useState<PersistedWeeklyRouteProposal | null>(null);
  const total = useMemo(() => record?.proposal.days.reduce((sum, day) => sum + day.suggestions.length, 0) ?? 0, [record]);
  const dirty = Boolean(record && savedDaysSignature !== null
    && JSON.stringify(record.proposal.days) !== savedDaysSignature);
  const routeConflict = useMemo(() => {
    if (!record || !planning || planning.sellerId !== record.proposal.sellerId
        || planning.weekStart !== record.proposal.weekStart) return false;
    const locations = new Map(planning.candidates.map(({ clientId, location }) => [clientId, location]));
    return record.proposal.days.some(({ suggestions }) => {
      let previous: { latitude: number; longitude: number } | null = null;
      return suggestions.some((item) => {
        const current = locations.get(item.clientId);
        if (!current) return false;
        const conflict = previous !== null && approximateDistanceKm(previous, current) > planning.maxLegDistanceKm;
        previous = current;
        return conflict;
      });
    });
  }, [planning, record]);
  const dayKinds = useMemo(() => {
    if (!record || !planning || planning.sellerId !== record.proposal.sellerId
        || planning.weekStart !== record.proposal.weekStart) return new Map<number, 'local' | 'trip'>();
    const locations = new Map(planning.candidates.map(({ clientId, location }) => [clientId, location]));
    return new Map(record.proposal.days.map(({ dayIndex, suggestions }) => [dayIndex,
      classifyDailyRoute(planning.origin, suggestions.flatMap(({ clientId }) => {
        const location = locations.get(clientId); return location ? [location] : [];
      }))]));
  }, [planning, record]);
  const planningNames = useMemo(() => new Map(planning?.candidates.map(({ clientId, name }) => [clientId, name]) ?? []),
    [planning]);

  useEffect(() => { void scrapRequest(clientSellersPath).then(clientSellerListResponseSchema.parse)
    .then((data) => { setSellers(data.sellers); setSellerId(data.sellers[0]?.id ?? ''); })
    .catch(() => setMessage('Não foi possível carregar os vendedores.')); }, []);

  function acceptServerRecord(value: PersistedWeeklyRouteProposal) {
    setRecord(value);
    setSavedRecord(value);
    setSavedDaysSignature(JSON.stringify(value.proposal.days));
  }

  function resetContext() {
    setRecord(null); setSavedRecord(null); setPlanning(null); setSelectedClientIds([]); setSavedDaysSignature(null);
    setAvailableClients([]); setMessage('');
  }

  function changeSeller(nextSellerId: string) {
    if (dirty && !window.confirm('Descartar as alterações locais ainda não salvas?')) return;
    setSellerId(nextSellerId); resetContext();
  }

  function changeWeek(nextWeekStart: string) {
    if (dirty && !window.confirm('Descartar as alterações locais ainda não salvas?')) return;
    setWeekStart(nextWeekStart); resetContext();
  }

  async function generate(operation: 'open_or_generate' | 'regenerate' = 'open_or_generate') {
    if (!sellerId) return;
    if (operation === 'regenerate' && (!record || !window.confirm(
      'Regenerar a sugestão com os dados atuais? A versão publicada, quando existir, será preservada até uma nova aprovação.'))) return;
    if (dirty && !window.confirm('Descartar as alterações locais e abrir os dados atuais do servidor?')) return;
    setBusy(true); setMessage('');
    try {
      const result = await scrapRequest(endpoint, { method: 'POST', headers,
        body: JSON.stringify({ schemaVersion: 1, sellerId, weekStart, operation, strategyPreference,
          idempotencyKey: crypto.randomUUID(),
          ...(operation === 'regenerate' && record
            ? { proposalId: record.proposalId, expectedVersion: record.version } : {}) }) });
      const mutation = weeklyRouteProposalMutationResponseSchema.parse(result);
      acceptServerRecord(mutation.record);
      setSelectedClientIds([]);
      const parameters = new URLSearchParams({ sellerId: mutation.record.proposal.sellerId,
        weekStart: mutation.record.proposal.weekStart });
      setPlanning(weeklyRoutePlanningResponseSchema.parse(await scrapRequest(`${endpoint}?${parameters}`)));
      setMessage(mutation.outcome === 'existing'
        ? 'A sugestão existente foi aberta sem criar duplicidade.'
        : mutation.outcome === 'regenerated'
          ? 'Sugestão regenerada com os dados atuais. Revise antes de publicar.'
          : 'Sugestão por regras criada como rascunho. Revise antes de publicar.');
    } catch (error) {
      setMessage(error instanceof ScrapRequestError && error.serverMessage
        ? error.serverMessage
        : error instanceof Error ? error.message : 'Não foi possível abrir a sugestão.');
    }
    finally { setBusy(false); }
  }

  async function loadPlanningMap() {
    const planningSellerId = record?.proposal.sellerId ?? sellerId;
    const planningWeekStart = record?.proposal.weekStart ?? weekStart;
    if (!planningSellerId) return;
    setBusy(true); setMessage(''); setSelectedClientIds([]);
    try {
      const parameters = new URLSearchParams({ sellerId: planningSellerId, weekStart: planningWeekStart });
      const result = weeklyRoutePlanningResponseSchema.parse(await scrapRequest(`${endpoint}?${parameters}`));
      setPlanning(result);
      setMessage(`${result.counts.positioned} clientes elegíveis posicionados no mapa.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível carregar o mapa inteligente.'); }
    finally { setBusy(false); }
  }

  function move(dayIndex: number, index: number, direction: -1 | 1) {
    if (!record) return;
    const target = index + direction;
    const day = record.proposal.days[dayIndex];
    if (!day || target < 0 || target >= day.suggestions.length) return;
    const suggestions = [...day.suggestions];
    [suggestions[index], suggestions[target]] = [suggestions[target]!, suggestions[index]!];
    const normalized = suggestions.map((item, position) => ({ ...item, plannedOrder: position + 1 }));
    setRecord({ ...record, proposal: { ...record.proposal, days: record.proposal.days.map((item, position) =>
      position === dayIndex ? { ...item, suggestions: normalized } : item) } });
  }

  function remove(dayIndex: number, clientId: string) {
    if (!record) return;
    const removed = record.proposal.days[dayIndex]?.suggestions.find((item) => item.clientId === clientId);
    setRecord({ ...record, proposal: { ...record.proposal,
      counts: { ...record.proposal.counts, suggested: Math.max(0, record.proposal.counts.suggested - 1),
        coveragePlanned: Math.max(0, record.proposal.counts.coveragePlanned
          - (removed && coverageDueStates.has(removed.coverageState) ? 1 : 0)),
        coveragePending: record.proposal.counts.coveragePending
          + (removed && coverageDueStates.has(removed.coverageState) ? 1 : 0) },
      days: record.proposal.days.map((day, position) =>
      position === dayIndex ? { ...day, suggestions: day.suggestions.filter((item) => item.clientId !== clientId)
        .map((item, index) => ({ ...item, plannedOrder: index + 1 })) } : day) } });
  }

  function changeDay(dayIndex: number, index: number, direction: -1 | 1) {
    if (!record) return;
    const target = dayIndex + direction; const sourceDay = record.proposal.days[dayIndex];
    const targetDay = record.proposal.days[target]; const selected = sourceDay?.suggestions[index];
    if (!sourceDay || !targetDay || !selected || targetDay.suggestions.length >= 10) return;
    setRecord({ ...record, proposal: { ...record.proposal, days: record.proposal.days.map((day, position) => {
      if (position === dayIndex) return { ...day, suggestions: day.suggestions.filter((_, itemIndex) => itemIndex !== index)
        .map((item, order) => ({ ...item, plannedOrder: order + 1 })) };
      if (position === target) return { ...day, suggestions: [...day.suggestions,
        { ...selected, dayIndex: target, plannedOrder: day.suggestions.length + 1 }] };
      return day;
    }) } });
  }

  async function searchClients() {
    if (!sellerId || !clientQuery.trim()) return;
    setBusy(true); setMessage('');
    try {
      const parameters = new URLSearchParams({ sellerId, q: clientQuery.trim(), page: '1', pageSize: '25' });
      const result = clientListResponseSchema.parse(await scrapRequest(`${clientsPath}?${parameters}`));
      setAvailableClients(result.clients);
      if (result.clients.length === 0) setMessage('Nenhum cliente ativo desta carteira foi encontrado.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível pesquisar a carteira.'); }
    finally { setBusy(false); }
  }

  function suggestionFor(candidate: WeeklyRoutePlanningCandidate, plannedOrder: number, manual = false) {
    return { clientId: candidate.clientId, name: candidate.name, dayIndex: targetDay, plannedOrder,
      score: candidate.score, approximateDistanceKm: candidate.distanceFromBaseKm,
      reasons: manual ? ['incluído manualmente pelo gestor', ...candidate.reasons].slice(0, 8) : candidate.reasons,
      locationPending: candidate.location === null, scrapBalanceState: candidate.scrapBalanceState,
      lastCompletedVisitAt: candidate.lastCompletedVisitAt, coverageState: candidate.coverageState,
      coverageOverdueDays: candidate.coverageOverdueDays, nextVisitDueOn: candidate.nextVisitDueOn };
  }

  async function addClient(client: ImportedClient) {
    if (!record || record.proposal.days[targetDay]!.suggestions.length >= 10 ||
        record.proposal.days.some((day) => day.suggestions.some((item) => item.clientId === client.id))) return;
    setBusy(true); setMessage('');
    try {
      let snapshot = planning;
      if (!snapshot || snapshot.sellerId !== record.proposal.sellerId || snapshot.weekStart !== record.proposal.weekStart) {
        const parameters = new URLSearchParams({ sellerId: record.proposal.sellerId, weekStart: record.proposal.weekStart });
        snapshot = weeklyRoutePlanningResponseSchema.parse(await scrapRequest(`${endpoint}?${parameters}`));
        setPlanning(snapshot);
      }
      const candidate = snapshot.candidates.find(({ clientId }) => clientId === client.id);
      if (!candidate) {
        setMessage('Este cliente não consta no planejamento atual. Atualize a carteira antes de incluí-lo; a cobertura não foi alterada.');
        return;
      }
      const coverageAdded = coverageDueStates.has(candidate.coverageState) ? 1 : 0;
      setRecord({ ...record, proposal: { ...record.proposal,
        counts: { ...record.proposal.counts, suggested: record.proposal.counts.suggested + 1,
          coveragePlanned: record.proposal.counts.coveragePlanned + coverageAdded,
          coveragePending: Math.max(0, record.proposal.counts.coveragePending - coverageAdded) },
        days: record.proposal.days.map((day, index) => index === targetDay
          ? { ...day, suggestions: [...day.suggestions, suggestionFor(candidate, day.suggestions.length + 1, true)] } : day) } });
      setAvailableClients((current) => current.filter((item) => item.id !== client.id));
      setMessage(candidate.location === null
        ? 'Cliente incluído com cobertura preservada e localização pendente. A distância será revalidada ao salvar.'
        : 'Cliente incluído com os dados de cobertura do planejamento. Salve a revisão antes de publicar.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível consultar a cobertura deste cliente. Tente novamente.');
    } finally { setBusy(false); }
  }

  function addMapSelection() {
    if (!record || !planning || planning.sellerId !== record.proposal.sellerId
        || planning.weekStart !== record.proposal.weekStart) {
      setMessage('Gere o rascunho antes de adicionar a seleção do mapa.'); return;
    }
    const day = record.proposal.days[targetDay]!;
    const alreadyPlanned = new Set(record.proposal.days.flatMap(({ suggestions }) =>
      suggestions.map(({ clientId }) => clientId)));
    const byId = new Map(planning.candidates.map((candidate) => [candidate.clientId, candidate]));
    const additions = [...new Set(selectedClientIds)].flatMap((id) => {
      const candidate = byId.get(id);
      return candidate && !alreadyPlanned.has(candidate.clientId)
        ? [candidate] : [];
    }).sort((left, right) => right.score - left.score);
    const ordered = [...day.suggestions];
    let capacityPending = 0; let distancePending = 0;
    for (const candidate of additions) {
      if (ordered.length >= 10) { capacityPending += 1; continue; }
      const previousLocation = ordered.map(({ clientId }) => byId.get(clientId)?.location).reverse().find((location) => location != null);
      if (previousLocation && candidate.location
          && approximateDistanceKm(previousLocation, candidate.location) > planning.maxLegDistanceKm) { distancePending += 1; continue; }
      ordered.push(suggestionFor(candidate, ordered.length + 1));
    }
    const added = ordered.length - day.suggestions.length;
    const addedCoverage = ordered.slice(day.suggestions.length)
      .filter(({ coverageState }) => coverageDueStates.has(coverageState)).length;
    setRecord({ ...record, proposal: { ...record.proposal,
      counts: { ...record.proposal.counts, suggested: record.proposal.counts.suggested + added,
        coveragePlanned: record.proposal.counts.coveragePlanned + addedCoverage,
        coveragePending: Math.max(0, record.proposal.counts.coveragePending - addedCoverage) },
      days: record.proposal.days.map((item, index) => index === targetDay
        ? { ...item, suggestions: ordered } : item) } });
    const unpositionedAdded = ordered.slice(day.suggestions.length).filter(({ locationPending }) => locationPending).length;
    const existing = selectedClientIds.filter((id) => alreadyPlanned.has(id)).length;
    const unavailable = selectedClientIds.filter((id) => !byId.has(id)).length;
    setMessage(`${added} cliente(s) adicionados ao dia ${targetDay + 1}; ${unpositionedAdded} com localização pendente. `
      + `${capacityPending} pendentes por capacidade; ${distancePending} por distância; ${existing} já planejados; ${unavailable} fora do planejamento atual. `
      + 'Clientes sem coordenadas permanecem no rascunho e a validação final é feita ao salvar.');
  }

  async function revise() {
    if (!record) return;
    if (routeConflict) { setMessage('A ordem possui paradas consecutivas acima de 30 km. Reorganize antes de salvar.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await scrapRequest(`${endpoint}/${record.proposalId}`, { method: 'PATCH', headers,
        body: JSON.stringify({ schemaVersion: 1, idempotencyKey: crypto.randomUUID(),
          expectedVersion: record.version, days: record.proposal.days }) });
      acceptServerRecord(persistedWeeklyRouteProposalSchema.parse(result)); setMessage('Ordem revisada e salva.');
    } catch (error) { setMessage(error instanceof ScrapRequestError && error.serverMessage
      ? error.serverMessage : error instanceof Error ? error.message : 'Não foi possível salvar a revisão.'); }
    finally { setBusy(false); }
  }

  async function decide(decision: 'publish' | 'reject') {
    if (!record || (decision === 'reject' && !rejectReason.trim())) return;
    if (decision === 'publish' && routeConflict) {
      setMessage('A proposta não pode ser publicada com trechos acima de 30 km.'); return;
    }
    if (decision === 'publish' && dirty) {
      setMessage('Salve a ordem revisada antes de publicar. Nenhuma alteração local será ignorada.'); return;
    }
    setBusy(true); setMessage('');
    try {
      const result = await scrapRequest(`${endpoint}/${record.proposalId}`, { method: 'PATCH', headers,
        body: JSON.stringify({ schemaVersion: 1, idempotencyKey: crypto.randomUUID(),
          expectedVersion: record.version, decision, reason: decision === 'reject' ? rejectReason.trim() : null }) });
      acceptServerRecord(persistedWeeklyRouteProposalSchema.parse(result));
      setMessage(decision === 'publish' ? 'Semana publicada para o vendedor.' : 'Sugestão descartada com auditoria.');
    } catch (error) { setMessage(error instanceof ScrapRequestError && error.serverMessage
      ? error.serverMessage : error instanceof Error ? error.message : 'Não foi possível concluir a decisão.'); }
    finally { setBusy(false); }
  }

  return <main className="route-planner-page">
    <header className="route-planner-heading"><div><p className="manager-eyebrow">INTELIGÊNCIA DE ROTAS</p>
      <h1>Planejamento semanal de visitas</h1><p>A sugestão por regras protege a rotina da carteira e destaca oportunidades comerciais, proximidade e débito de sucata. O vendedor só recebe após sua aprovação.</p></div></header>
    <section className="route-planner-filters" aria-label="Parâmetros da sugestão">
      <label>Segunda-feira da semana<input type="date" value={weekStart} onChange={(event) => changeWeek(event.target.value)} disabled={busy} /></label>
      <label>Vendedor<select value={sellerId} onChange={(event) => changeSeller(event.target.value)} disabled={busy}>
        {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.displayName}</option>)}</select></label>
      <label>Preferência de estratégia<select value={strategyPreference} disabled={busy}
        onChange={(event) => setStrategyPreference(event.target.value as 'auto' | 'local' | 'trip')}>
        <option value="auto">Automática</option><option value="local">Semana local</option><option value="trip">Semana de viagem</option>
      </select></label>
      <button className="route-planner-publish" type="button" onClick={() => void generate()} disabled={busy || !sellerId}>{busy ? 'Processando…' : 'Abrir ou criar sugestão'}</button>
      <button type="button" onClick={() => void loadPlanningMap()} disabled={busy || !sellerId}>Abrir mapa inteligente</button>
      {record && <button type="button" onClick={() => void generate('regenerate')} disabled={busy || !sellerId}>Regenerar com dados atuais</button>}
      <p className="route-planner-strategy-help">A preferência de estratégia é aplicada ao criar ou regenerar.
        Abrir uma sugestão existente preserva a estratégia já salva.</p>
    </section>
    {message && <p className="route-planner-message" role="status">{message}</p>}
    {dirty && <div className="route-planner-message is-conflict" role="alert">Há alterações locais não salvas. Salve a revisão antes de publicar, trocar o contexto ou regenerar.
      <button type="button" onClick={() => { if (savedRecord) setRecord(savedRecord); }}>Descartar alterações locais</button></div>}
    {routeConflict && <div className="route-planner-message is-conflict" role="alert">
      <span>Esta versão possui trecho acima de 30 km entre paradas e não pode ser publicada.</span>
      <button type="button" disabled={busy || record?.status !== 'draft'} onClick={() => void generate('regenerate')}>
        Corrigir rota com os dados atuais
      </button>
    </div>}
    {planning && <><WeeklyRoutePlanningMap planning={planning} mapConfig={mapConfig}
      selectedIds={selectedClientIds} onSelection={setSelectedClientIds} />
      <section className="route-intelligence-apply"><label>Adicionar seleção no dia<select value={targetDay}
        onChange={(event) => setTargetDay(Number(event.target.value))}>
        {Array.from({ length: 5 }, (_, index) => <option key={index} value={index}>Dia {index + 1}</option>)}</select></label>
        <button type="button" disabled={busy || selectedClientIds.length === 0 || !record}
          onClick={addMapSelection}>Adicionar seleção ao rascunho</button></section></>}
    {record && <><section className="route-planner-actions"><p>{record.status === 'draft' ? 'RASCUNHO VERSIONADO' : record.status.toUpperCase()}</p><h2>{total} clientes na semana</h2>
      <dl><div><dt>Inteligência</dt><dd>Sugestão por regras auditáveis</dd></div><div><dt>Limite</dt><dd>10 por dia</dd></div>
        <div><dt>Origem</dt><dd>{record.proposal.origin.city}/{record.proposal.origin.state}</dd></div><div><dt>Versão</dt><dd>{record.version}</dd></div>
        <div><dt>Estratégia</dt><dd>{record.proposal.strategy.kind === 'trip' ? 'Semana de viagem' : record.proposal.strategy.kind === 'local' ? 'Semana local' : 'Distâncias pendentes'}
          {record.proposal.strategy.region ? ` · ${record.proposal.strategy.region}` : ''}
          {record.proposal.strategy.distanceFromBaseKm !== null ? ` · ${record.proposal.strategy.distanceFromBaseKm.toLocaleString('pt-BR')} km da origem` : ''}</dd></div>
        <div><dt>Rotina de visitas</dt><dd>{record.proposal.counts.coveragePlanned}/{record.proposal.counts.coverageDue} prioridades cobertas</dd></div></dl>
      <p>{record.proposal.counts.inactiveLost} clientes com mais de 180 dias, {record.proposal.counts.noPurchaseHistory} sem histórico e {record.proposal.counts.needsReview} com cadastro ou agrupamento geográfico pendente ficaram fora da sugestão.</p></section>
      {record.proposal.excluded.length > 0 && <details className="route-planner-pending" aria-label="Clientes pendentes da sugestão">
        <summary><span><strong>{record.proposal.excluded.length} clientes pendentes</strong>
          <small>Fora desta sugestão; continuam disponíveis para revisão.</small></span><span>Ver detalhes</span></summary>
        <ul className="route-planner-client-list">{record.proposal.excluded.map((item) => <li key={`${item.clientId}-${item.reason}`}>
          <div><strong>{item.name ?? planningNames.get(item.clientId) ?? 'Nome do cliente indisponível'}</strong>
            <small>{exclusionLabels[item.reason] ?? item.reason}</small></div></li>)}</ul>
      </details>}
      <div className="route-planner-workspace">
        {record.proposal.days.map((day, dayIndex) => <section className="route-planner-composition" key={day.serviceDate}>
          <div className="route-planner-section-title"><div><p>DIA {dayIndex + 1}</p><h2>{new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC'}).format(new Date(`${day.serviceDate}T12:00:00Z`))}</h2></div><span>{day.suggestions.length}/10{dayKinds.has(dayIndex) ? ` · ${dayKinds.get(dayIndex) === 'trip' ? 'viagem' : 'local'}` : ''}</span></div>
          {day.suggestions.length === 0 && <p className="route-planner-empty">Nenhum cliente elegível para este dia.</p>}
          <ol className="route-planner-stop-list">{day.suggestions.map((item, index) => <li key={item.clientId}>
            <span className="route-planner-order">{index + 1}</span><div className="route-planner-stop-info"><strong>{item.name}</strong>
              <small>{coverageLabel(item.coverageState)}</small><span>{item.reasons.join(' · ')}</span>
              {item.locationPending && <small className="route-planner-location-pending">Sem coordenadas · localização e distância pendentes.</small>}</div>
            <div className="route-planner-stop-actions"><button type="button" disabled={index === 0 || busy} onClick={() => move(dayIndex,index,-1)}>↑</button>
              <button type="button" disabled={index === day.suggestions.length - 1 || busy} onClick={() => move(dayIndex,index,1)}>↓</button>
              <button type="button" disabled={dayIndex === 0 || busy || record.proposal.days[dayIndex - 1]!.suggestions.length >= 10} onClick={() => changeDay(dayIndex,index,-1)}>Dia anterior</button>
              <button type="button" disabled={dayIndex === 4 || busy || record.proposal.days[dayIndex + 1]!.suggestions.length >= 10} onClick={() => changeDay(dayIndex,index,1)}>Dia seguinte</button>
              <button type="button" className="is-danger" disabled={busy} onClick={() => remove(dayIndex,item.clientId)}>Remover</button></div></li>)}</ol>
        </section>)}</div>
      {record.status === 'draft' && <aside className="route-planner-actions"><h2>Decisão do gestor</h2>
        <h3>Adicionar cliente da carteira</h3><label>Buscar por nome, CNPJ ou razão social<input value={clientQuery} onChange={(event) => setClientQuery(event.target.value)} /></label>
        <label>Adicionar no dia<select value={targetDay} onChange={(event) => setTargetDay(Number(event.target.value))}>
          {record.proposal.days.map((day,index) => <option key={day.serviceDate} value={index}>Dia {index + 1} · {day.suggestions.length}/10</option>)}</select></label>
        <button type="button" disabled={busy || !clientQuery.trim()} onClick={() => void searchClients()}>Pesquisar carteira</button>
        {availableClients.length > 0 && <ul className="route-planner-client-list">{availableClients.map((client) => <li key={client.id}>
          <div><strong>{client.name}</strong><small>{client.externalReference} · {client.address}</small></div>
          <button type="button" disabled={busy || record.proposal.days[targetDay]!.suggestions.length >= 10}
            onClick={() => void addClient(client)}>Adicionar</button></li>)}</ul>}
        <button type="button" className="route-planner-save" disabled={busy || routeConflict || !planning || !dirty} onClick={() => void revise()}>Salvar ordem revisada</button>
        <button type="button" className="route-planner-publish" disabled={busy || total === 0 || routeConflict || !planning || dirty} onClick={() => void decide('publish')}>Publicar semana</button>
        <label>Motivo para descartar<textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={500} rows={3} /></label>
        <button type="button" disabled={busy || !rejectReason.trim()} onClick={() => void decide('reject')}>Descartar proposta</button></aside>}
    </>}
  </main>;
}
