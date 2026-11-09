'use client';

import { useEffect, useMemo, useState } from 'react';
import { clientListResponseSchema, clientSellerListResponseSchema, clientSellersPath, clientsPath,
  persistedWeeklyRouteProposalSchema, weeklyRoutePlanningResponseSchema,
  type ImportedClient, type PersistedWeeklyRouteProposal,
  type WeeklyRoutePlanningResponse } from '@cirne/contracts';
import type { ManagementMapPublicConfig } from '@cirne/config/server';
import { approximateDistanceKm, classifyDailyRoute } from '@cirne/domain';
import { WeeklyRoutePlanningMap } from './weekly-route-planning-map';
import { ScrapRequestError, scrapRequest } from '../scrap/scrap-ui';

const endpoint = '/api/v1/management/weekly-route-proposals';
const headers = { 'content-type': 'application/json', 'x-csrf-token': 'cirne-route-v1' };

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
  const [record, setRecord] = useState<PersistedWeeklyRouteProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [availableClients, setAvailableClients] = useState<ImportedClient[]>([]);
  const [targetDay, setTargetDay] = useState(0);
  const [planning, setPlanning] = useState<WeeklyRoutePlanningResponse | null>(null);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const total = useMemo(() => record?.proposal.days.reduce((sum, day) => sum + day.suggestions.length, 0) ?? 0, [record]);
  const routeConflict = useMemo(() => {
    if (!record || !planning || planning.sellerId !== record.proposal.sellerId
        || planning.weekStart !== record.proposal.weekStart) return false;
    const locations = new Map(planning.candidates.map(({ clientId, location }) => [clientId, location]));
    return record.proposal.days.some(({ suggestions }) => suggestions.some((item, index) => {
      if (index === 0) return false;
      const previous = locations.get(suggestions[index - 1]!.clientId);
      const current = locations.get(item.clientId);
      return previous && current
        ? approximateDistanceKm(previous, current) > planning.maxLegDistanceKm : false;
    }));
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

  useEffect(() => { void scrapRequest(clientSellersPath).then(clientSellerListResponseSchema.parse)
    .then((data) => { setSellers(data.sellers); setSellerId(data.sellers[0]?.id ?? ''); })
    .catch(() => setMessage('Não foi possível carregar os vendedores.')); }, []);

  async function generate() {
    if (!sellerId) return;
    setBusy(true); setMessage(''); setRecord(null); setPlanning(null); setSelectedClientIds([]);
    try {
      const result = await scrapRequest(endpoint, { method: 'POST', headers,
        body: JSON.stringify({ schemaVersion: 1, sellerId, weekStart, idempotencyKey: crypto.randomUUID() }) });
      setRecord(persistedWeeklyRouteProposalSchema.parse(result));
      const parameters = new URLSearchParams({ sellerId, weekStart });
      setPlanning(weeklyRoutePlanningResponseSchema.parse(await scrapRequest(`${endpoint}?${parameters}`)));
      setMessage('Sugestão criada como rascunho. Revise antes de publicar.');
    } catch (error) {
      setMessage(error instanceof ScrapRequestError && error.status === 422 && error.serverMessage
        ? error.serverMessage
        : error instanceof Error ? error.message : 'Não foi possível gerar a sugestão.');
    }
    finally { setBusy(false); }
  }

  async function loadPlanningMap() {
    const planningSellerId = record?.proposal.sellerId ?? sellerId;
    const planningWeekStart = record?.proposal.weekStart ?? weekStart;
    if (!planningSellerId) return;
    setBusy(true); setMessage(''); setPlanning(null); setSelectedClientIds([]);
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
    setRecord({ ...record, proposal: { ...record.proposal,
      counts: { ...record.proposal.counts, suggested: Math.max(0, record.proposal.counts.suggested - 1) },
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

  function addClient(client: ImportedClient) {
    if (!record || record.proposal.days[targetDay]!.suggestions.length >= 10 ||
        record.proposal.days.some((day) => day.suggestions.some((item) => item.clientId === client.id))) return;
    setRecord({ ...record, proposal: { ...record.proposal,
      counts: { ...record.proposal.counts, suggested: record.proposal.counts.suggested + 1 },
      days: record.proposal.days.map((day, index) =>
      index === targetDay ? { ...day, suggestions: [...day.suggestions, { clientId: client.id, name: client.name,
        dayIndex: targetDay, plannedOrder: day.suggestions.length + 1, score: 0,
        approximateDistanceKm: null, reasons: ['incluído manualmente pelo gestor'],
        locationPending: client.latitude === null || client.longitude === null, scrapBalanceState: 'unavailable' }] } : day) } });
    setAvailableClients((current) => current.filter((item) => item.id !== client.id));
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
    const additions = selectedClientIds.flatMap((id) => {
      const candidate = byId.get(id);
      return candidate && candidate.location !== null && !alreadyPlanned.has(candidate.clientId)
        ? [candidate] : [];
    })
      .sort((left, right) => right.score - left.score).slice(0, Math.max(0, 10 - day.suggestions.length));
    const ordered = [...day.suggestions];
    for (const candidate of additions) {
      const previous = ordered.at(-1);
      const previousLocation = previous ? byId.get(previous.clientId)?.location : null;
      if (previousLocation && candidate.location
          && approximateDistanceKm(previousLocation, candidate.location) > planning.maxLegDistanceKm) continue;
      ordered.push({ clientId: candidate.clientId, name: candidate.name, dayIndex: targetDay,
        plannedOrder: ordered.length + 1, score: candidate.score,
        approximateDistanceKm: candidate.distanceFromBaseKm, reasons: candidate.reasons,
        locationPending: false, scrapBalanceState: candidate.scrapBalanceState });
    }
    const added = ordered.length - day.suggestions.length;
    setRecord({ ...record, proposal: { ...record.proposal,
      counts: { ...record.proposal.counts, suggested: record.proposal.counts.suggested + added },
      days: record.proposal.days.map((item, index) => index === targetDay
        ? { ...item, suggestions: ordered } : item) } });
    setMessage(added === additions.length ? `${added} cliente(s) adicionados ao dia ${targetDay + 1}.`
      : `${added} cliente(s) adicionados; os demais excederiam 10 visitas ou 30 km entre paradas.`);
  }

  async function revise() {
    if (!record) return;
    if (routeConflict) { setMessage('A ordem possui paradas consecutivas acima de 30 km. Reorganize antes de salvar.'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await scrapRequest(`${endpoint}/${record.proposalId}`, { method: 'PATCH', headers,
        body: JSON.stringify({ schemaVersion: 1, idempotencyKey: crypto.randomUUID(),
          expectedVersion: record.version, days: record.proposal.days }) });
      setRecord(persistedWeeklyRouteProposalSchema.parse(result)); setMessage('Ordem revisada e salva.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível salvar a revisão.'); }
    finally { setBusy(false); }
  }

  async function decide(decision: 'publish' | 'reject') {
    if (!record || (decision === 'reject' && !rejectReason.trim())) return;
    if (decision === 'publish' && routeConflict) {
      setMessage('A proposta não pode ser publicada com trechos acima de 30 km.'); return;
    }
    setBusy(true); setMessage('');
    try {
      const result = await scrapRequest(`${endpoint}/${record.proposalId}`, { method: 'PATCH', headers,
        body: JSON.stringify({ schemaVersion: 1, idempotencyKey: crypto.randomUUID(),
          expectedVersion: record.version, decision, reason: decision === 'reject' ? rejectReason.trim() : null }) });
      setRecord(persistedWeeklyRouteProposalSchema.parse(result));
      setMessage(decision === 'publish' ? 'Semana publicada para o vendedor.' : 'Sugestão descartada com auditoria.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Não foi possível concluir a decisão.'); }
    finally { setBusy(false); }
  }

  return <main className="route-planner-page">
    <header className="route-planner-heading"><div><p className="manager-eyebrow">INTELIGÊNCIA DE ROTAS</p>
      <h1>Sugestão semanal</h1><p>Regras transparentes combinam oportunidade, proximidade e débito de sucata. O vendedor só recebe após sua aprovação.</p></div></header>
    <section className="route-planner-filters" aria-label="Parâmetros da sugestão">
      <label>Segunda-feira da semana<input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} disabled={busy} /></label>
      <label>Vendedor<select value={sellerId} onChange={(event) => setSellerId(event.target.value)} disabled={busy}>
        {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.displayName}</option>)}</select></label>
      <button className="route-planner-publish" type="button" onClick={() => void generate()} disabled={busy || !sellerId}>{busy ? 'Processando…' : 'Gerar sugestão'}</button>
      <button type="button" onClick={() => void loadPlanningMap()} disabled={busy || !sellerId}>Abrir mapa inteligente</button>
    </section>
    {message && <p className="route-planner-message" role="status">{message}</p>}
    {routeConflict && <p className="route-planner-message is-conflict" role="alert">Há trecho acima de 30 km entre paradas consecutivas.</p>}
    {planning && <><WeeklyRoutePlanningMap planning={planning} mapConfig={mapConfig}
      selectedIds={selectedClientIds} onSelection={setSelectedClientIds} />
      <section className="route-intelligence-apply"><label>Adicionar seleção no dia<select value={targetDay}
        onChange={(event) => setTargetDay(Number(event.target.value))}>
        {Array.from({ length: 5 }, (_, index) => <option key={index} value={index}>Dia {index + 1}</option>)}</select></label>
        <button type="button" disabled={busy || selectedClientIds.length === 0 || !record}
          onClick={addMapSelection}>Adicionar seleção ao rascunho</button></section></>}
    {record && <><section className="route-planner-actions"><p>RASCUNHO VERSIONADO</p><h2>{total} clientes na semana</h2>
      <dl><div><dt>Política</dt><dd>{record.proposal.policy.version}</dd></div><div><dt>Limite</dt><dd>10 por dia</dd></div>
        <div><dt>Origem</dt><dd>{record.proposal.origin.city}/{record.proposal.origin.state}</dd></div><div><dt>Versão</dt><dd>{record.version}</dd></div></dl>
      <p>{record.proposal.counts.inactiveLost} clientes com mais de 180 dias, {record.proposal.counts.noPurchaseHistory} sem histórico e {record.proposal.counts.needsReview} com cadastro ou agrupamento geográfico pendente ficaram fora da sugestão.</p></section>
      <div className="route-planner-workspace">
        {record.proposal.days.map((day, dayIndex) => <section className="route-planner-composition" key={day.serviceDate}>
          <div className="route-planner-section-title"><div><p>DIA {dayIndex + 1}</p><h2>{new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC'}).format(new Date(`${day.serviceDate}T12:00:00Z`))}</h2></div><span>{day.suggestions.length}/10{dayKinds.has(dayIndex) ? ` · ${dayKinds.get(dayIndex) === 'trip' ? 'viagem' : 'local'}` : ''}</span></div>
          {day.suggestions.length === 0 && <p className="route-planner-empty">Nenhum cliente elegível para este dia.</p>}
          <ol className="route-planner-stop-list">{day.suggestions.map((item, index) => <li key={item.clientId}>
            <span className="route-planner-order">{index + 1}</span><div className="route-planner-stop-info"><strong>{item.name}</strong>
              <span>{item.reasons.join(' · ')}</span>{item.locationPending && <small>Distância pendente; endereço navegável preservado.</small>}</div>
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
          <button type="button" disabled={record.proposal.days[targetDay]!.suggestions.length >= 10} onClick={() => addClient(client)}>Adicionar</button></li>)}</ul>}
        <button type="button" className="route-planner-save" disabled={busy || routeConflict || !planning} onClick={() => void revise()}>Salvar ordem revisada</button>
        <button type="button" className="route-planner-publish" disabled={busy || total === 0 || routeConflict || !planning} onClick={() => void decide('publish')}>Publicar semana</button>
        <label>Motivo para descartar<textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} maxLength={500} rows={3} /></label>
        <button type="button" disabled={busy || !rejectReason.trim()} onClick={() => void decide('reject')}>Descartar proposta</button></aside>}
    </>}
  </main>;
}
