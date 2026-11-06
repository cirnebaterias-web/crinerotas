'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  assignLogisticsPickupSchema, recordLogisticsPickupSchema, correctLogisticsPickupSchema, reviewLogisticsPickupSchema,
  type LogisticsPickupRecord, type LogisticsPickupList, type LogisticsOperatorList, type LogisticsPickupAction,
  type MeResponse, type ScrapCollectionRoute,
} from '@cirne/contracts';
import { logisticsPickupsClient } from '@/lib/logistics-pickups-client';
import { scrapCollectionRoutesClient } from '@/lib/scrap-collection-routes-client';
import { sellerClient } from '@/lib/seller-client';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { localDate } from '@/features/scrap/scrap-ui';
import { decimalKg, equalWeight, formatPickupDocument, pickupOutcomeLabel } from './pickup-labels';

const dateLabel = (value: string) => value.split('-').reverse().join('/');
const timestampLabel = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const actionLabels = { schedule_created: 'Promessa registrada', schedule_revised: 'Promessa revisada', assigned: 'Rota atribuída', result_recorded: 'Resultado registrado', result_corrected: 'Resultado corrigido', reviewed: 'Divergência tratada' };

function PickupCard({ record, operators, manager, date, onSaved, interactionBlocked, onEditChange }: {
  record: LogisticsPickupRecord; operators: LogisticsOperatorList['operators']; manager: boolean; date: string; onSaved(): Promise<void>;
  interactionBlocked: boolean; onEditChange(editing: boolean): void;
}) {
  const [action, setAction] = useState<LogisticsPickupAction | null>(null);
  const [operatorId, setOperatorId] = useState(record.assignment?.operator.id ?? '');
  const [routeDate, setRouteDate] = useState(record.assignment?.routeDate ?? date);
  const [routeOrder, setRouteOrder] = useState(String(record.assignment?.routeOrder ?? ''));
  const [outcome, setOutcome] = useState<'collected' | 'not_collected'>('collected');
  const [weight, setWeight] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<{ body: string; key: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const actual = outcome === 'not_collected' ? '0' : weight.trim().replace(',', '.');
  const divergent = !equalWeight(actual, record.promisedWeightKg);

  useEffect(() => { if (action) formHeading.current?.focus(); }, [action]);
  function open(next: LogisticsPickupAction) {
    onEditChange(true);
    setAction(next); setError(''); setReason('');
    if (next === 'correction' && record.result) { setOutcome(record.result.outcome); setWeight(record.result.actualWeightKg); }
    else { setOutcome('collected'); setWeight(''); }
  }
  function cancel() { onEditChange(false); setAction(null); setError(''); heading.current?.focus(); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!action || busy) return;
    setError('');
    const base = { schemaVersion: 1, expectedVersion: record.version };
    let parsed;
    if (action === 'assignment') parsed = assignLogisticsPickupSchema.safeParse({ ...base, operatorId, routeDate, routeOrder: Number(routeOrder), reason });
    else if (action === 'review') parsed = reviewLogisticsPickupSchema.safeParse({ ...base, reason });
    else {
      if (divergent && !reason.trim()) { setError('Explique a diferença entre o peso prometido e o coletado.'); return; }
      parsed = (action === 'correction' ? correctLogisticsPickupSchema : recordLogisticsPickupSchema).safeParse({ ...base, outcome, actualWeightKg: actual, ...(reason.trim() ? { reason } : {}) });
    }
    if (!parsed.success) { setError('Revise os campos obrigatórios, a data, a ordem e o peso informado.'); return; }
    const body = JSON.stringify({ action, data: parsed.data });
    if (!operation.current || operation.current.body !== body) operation.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    try { await logisticsPickupsClient.mutate(record.scheduleId, action, parsed.data, operation.current.key); setAction(null); onEditChange(false); await onSaved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar. Tente novamente.'); }
    finally { setBusy(false); }
  }
  const title = action === 'assignment' ? 'Atribuir parada' : action === 'review' ? 'Tratar divergência' : action === 'correction' ? 'Corrigir resultado' : 'Registrar resultado';
  return <article className="logistics-pickup-card">
    <header><p className="seller-kicker">{record.assignment ? `PARADA ${record.assignment.routeOrder} · ${dateLabel(record.assignment.routeDate)}` : 'PENDENTE DE ATRIBUIÇÃO'}</p><h3 ref={heading} id={`pickup-${record.scheduleId}`} tabIndex={-1}>{record.client.name}</h3>{manager && <p>{formatPickupDocument(record.client.document)}</p>}</header>
    <p className="logistics-address"><strong>Endereço da coleta:</strong> {record.client.address}</p>
    {!manager && <p className="logistics-promised"><strong>{decimalKg(record.promisedWeightKg)} kg agendados</strong></p>}
    {manager && <><a className="seller-button seller-secondary" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(record.client.address)}`}>Abrir endereço no mapa</a>
      <dl className="logistics-weights"><div><dt>Prometido</dt><dd>{decimalKg(record.promisedWeightKg)} kg</dd></div><div><dt>Coletado</dt><dd>{record.result ? `${decimalKg(record.result.actualWeightKg)} kg` : 'Aguardando'}</dd></div><div><dt>Diferença</dt><dd>{record.result ? `${decimalKg(record.result.differenceKg)} kg` : '—'}</dd></div></dl>
      <p><strong>{pickupOutcomeLabel(record)}</strong>{record.reviewRequired ? ' · Revisão do gestor pendente' : record.review ? ' · Tratamento registrado' : ''}</p>
      <p>Solicitado para {dateLabel(record.desiredDate)} · {record.period === 'morning' ? 'Manhã' : 'Tarde'} · Vendedor: {record.seller.displayName}</p>
      {record.assignment && <p>Operador: {record.assignment.operator.displayName}</p>}
      {record.observation && <p><strong>Observação da solicitação:</strong> {record.observation}</p>}
      {record.result && <p>Registrado por {record.result.recordedBy.displayName} em {timestampLabel(record.result.recordedAt)}{record.result.reason ? ` · ${record.result.reason}` : ''}</p>}
      {record.review && <p className="seller-notice"><strong>Tratamento:</strong> {record.review.reason} · {record.review.reviewedBy.displayName} · {timestampLabel(record.review.reviewedAt)}</p>}</>}
    {!manager && <details className="logistics-history"><summary>Mais informações</summary>
      <a className="seller-button seller-secondary" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(record.client.address)}`}>Abrir endereço no mapa</a>
      <p>{formatPickupDocument(record.client.document)}</p><p>{pickupOutcomeLabel(record)}</p>
      {record.reviewRequired && <p>Revisão do gestor pendente</p>}
      {record.observation && <p><strong>Observação:</strong> {record.observation}</p>}
      {record.result && <p>Coletado: {decimalKg(record.result.actualWeightKg)} kg · diferença {decimalKg(record.result.differenceKg)} kg</p>}
    </details>}
    {!action && <div className="logistics-card-actions">
      {manager && !record.result && <button className="seller-button seller-primary" disabled={interactionBlocked} type="button" onClick={() => open('assignment')}>{record.assignment ? 'Alterar atribuição' : 'Atribuir à rota'}</button>}
      {!manager && !record.result && <button className="seller-button seller-primary" disabled={interactionBlocked} type="button" onClick={() => open('result')}>Informar coleta</button>}
      {manager && record.reviewRequired && <button className="seller-button seller-primary" disabled={interactionBlocked} type="button" onClick={() => open('review')}>Tratar divergência</button>}
      {manager && record.result && <button className="seller-button seller-secondary" disabled={interactionBlocked} type="button" onClick={() => open('correction')}>Corrigir resultado</button>}
    </div>}
    {action && <form onSubmit={save} className="logistics-pickup-form" aria-busy={busy}>
      <h4 ref={formHeading} tabIndex={-1}>{title}</h4>
      {action === 'assignment' ? <><label>Operador de logística<select required value={operatorId} disabled={busy} onChange={(e) => setOperatorId(e.target.value)}><option value="">Selecione o operador</option>{operators.map((operator) => <option value={operator.id} key={operator.id}>{operator.displayName}</option>)}</select></label>{!operators.length && <p role="status">Nenhum operador ativo disponível. Cadastre o perfil Logística na Administração.</p>}<label>Dia da rota<input type="date" min={localDate()} required value={routeDate} disabled={busy} onChange={(e) => setRouteDate(e.target.value)} /></label><label>Ordem da parada<input type="number" min="1" max="10000" step="1" required value={routeOrder} disabled={busy} onChange={(e) => setRouteOrder(e.target.value)} /></label></> : action !== 'review' && <>
        <label>Resultado<select value={outcome} disabled={busy} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="collected">Coletado</option><option value="not_collected">Não coletado</option></select></label>
        {outcome === 'collected' && <label>Peso realmente coletado em kg<input required inputMode="decimal" value={weight} disabled={busy} onChange={(e) => setWeight(e.target.value)} /></label>}
        <p>Promessa preservada: {decimalKg(record.promisedWeightKg)} kg. {outcome === 'not_collected' ? 'Serão registrados 0 kg coletados.' : 'Informe o peso aferido na coleta.'}</p>
      </>}
      <label>{action === 'review' ? 'Tratamento e encaminhamento' : 'Motivo / observação'}<textarea rows={3} maxLength={1000} required={action !== 'result' || divergent} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} /></label>
      {action === 'review' && <p>Registre a providência combinada. Este tratamento preserva os pesos e não cria outra coleta automaticamente.</p>}
      {action === 'correction' && <p>A correção preservará o resultado original no histórico e exigirá nova revisão quando houver diferença.</p>}
      {error && <p className="seller-notice seller-error" role="alert">{error}</p>}
      <div className="logistics-card-actions"><button className="seller-button seller-primary" disabled={busy}>{busy ? 'Confirmando…' : 'Confirmar registro'}</button><button className="seller-button seller-secondary" type="button" disabled={busy} onClick={cancel}>Cancelar</button></div>
    </form>}
    {manager && <details className="logistics-history"><summary>Histórico da promessa e da coleta</summary><ol>{record.history.map((entry, index) => <li key={`${entry.occurredAt}-${index}`}><strong>{actionLabels[entry.action]}</strong> · {entry.actor.displayName} · {timestampLabel(entry.occurredAt)}{entry.reason && <p>{entry.reason}</p>}{entry.after.promisedWeightKg && <p>Promessa: {decimalKg(entry.after.promisedWeightKg)} kg</p>}{entry.after.result && <p>Resultado: {decimalKg(entry.after.result.actualWeightKg)} kg · diferença {decimalKg(entry.after.result.differenceKg)} kg</p>}{entry.before?.result && <p>Antes: {decimalKg(entry.before.result.actualWeightKg)} kg</p>}</li>)}</ol></details>}
  </article>;
}

function CollectionRouteCard({ route, operators, available, onSaved }: { route: ScrapCollectionRoute;
  operators: LogisticsOperatorList['operators']; available: LogisticsPickupList['records']; onSaved(): Promise<void> }) {
  const [stops, setStops] = useState(route.stops);
  const [operatorId, setOperatorId] = useState(route.operatorId ?? '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setStops(route.stops); setOperatorId(route.operatorId ?? ''); }, [route]);
  async function run(operation: 'revise' | 'reorder' | 'approve' | 'assign') {
    setBusy(true); setError('');
    const body = operation === 'revise' ? { schemaVersion: 1, expectedVersion: route.version,
      scheduleIds: stops.map((stop) => stop.scheduleId), reason: 'Composição da rota revisada pelo gestor' }
      : operation === 'reorder' ? { schemaVersion: 1, expectedVersion: route.version,
      stops: stops.map((stop, index) => ({ scheduleId: stop.scheduleId, plannedOrder: index + 1 })),
      reason: 'Ordem revisada pelo gestor no painel' }
      : operation === 'approve' ? { schemaVersion: 1, expectedVersion: route.version,
        reason: 'Rota conferida e aprovada pelo gestor' }
        : { schemaVersion: 1, expectedVersion: route.version, operatorId,
          reason: 'Rota atribuída pelo gestor' };
    try { await scrapCollectionRoutesClient.change(route, operation, body, crypto.randomUUID()); await onSaved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível atualizar a rota.'); }
    finally { setBusy(false); }
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction; if (target < 0 || target >= stops.length) return;
    setStops((current) => { const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next; });
  }
  const changed = stops.some((stop, index) => stop.scheduleId !== route.stops[index]?.scheduleId);
  const compositionChanged = stops.length !== route.stops.length ||
    stops.some((stop) => !route.stops.some((original) => original.scheduleId === stop.scheduleId));
  return <article className="logistics-route-card"><p className="seller-kicker">ROTA {route.routeId}</p>
    <h3>Versão {route.version} · {route.counts.completed} de {route.counts.total} concluídas</h3>
    <ol className="logistics-route-stops">{stops.map((stop, index) => <li key={stop.scheduleId}>
      <div><strong>{stop.clientName}</strong><span>{stop.promisedWeightKg} kg · {stop.address}</span>
        <small>{stop.geographyStatus === 'calculated' ? 'Ordem aproximada por proximidade' : 'Localização pendente; ordem manual recomendada'}</small></div>
      {route.status !== 'in_progress' && route.status !== 'completed' && <div className="logistics-stop-order">
        <button type="button" disabled={busy || index === 0} aria-label={`Subir ${stop.clientName}`} onClick={() => move(index, -1)}>↑</button>
        <button type="button" disabled={busy || index === stops.length - 1} aria-label={`Descer ${stop.clientName}`} onClick={() => move(index, 1)}>↓</button>
        <button type="button" disabled={busy || stops.length === 1} aria-label={`Retirar ${stop.clientName}`}
          onClick={() => setStops((current) => current.filter(({ scheduleId }) => scheduleId !== stop.scheduleId))}>Retirar</button></div>}
    </li>)}</ol>
    {route.status !== 'in_progress' && route.status !== 'completed' && available.length > 0 && <label>Adicionar parada
      <select disabled={busy} value="" onChange={(event) => { const record = available.find(({ scheduleId }) => scheduleId === event.target.value);
        if (record && !stops.some(({ scheduleId }) => scheduleId === record.scheduleId)) setStops((current) => [...current, {
          scheduleId: record.scheduleId, clientName: record.client.name, address: record.client.address,
          promisedWeightKg: record.promisedWeightKg, location: null, suggestedOrder: current.length + 1,
          approximateFromPreviousKm: null, geographyStatus: 'pending_location', result: null }]); }}>
        <option value="">Selecione uma promessa pendente</option>{available.map((record) => <option key={record.scheduleId} value={record.scheduleId}>{record.client.name} · {record.promisedWeightKg} kg</option>)}</select></label>}
    {error && <p role="alert" className="seller-notice seller-error">{error}</p>}
    {changed && <p role="status" className="seller-notice">Alterações ainda não salvas.</p>}
    <div className="logistics-card-actions">
      {compositionChanged && <button className="seller-button seller-secondary" disabled={busy} onClick={() => void run('revise')}>Salvar paradas</button>}
      {changed && !compositionChanged && <button className="seller-button seller-secondary" disabled={busy} onClick={() => void run('reorder')}>Salvar nova ordem</button>}
      {changed && <button className="seller-button seller-secondary" disabled={busy} onClick={() => setStops(route.stops)}>Desfazer alterações</button>}
      {route.status === 'draft' && <button className="seller-button seller-primary" disabled={busy || changed} onClick={() => void run('approve')}>Aprovar rota</button>}
    </div>
    {(route.status === 'approved' || route.status === 'assigned') && <div className="logistics-toolbar">
      <label>Operador de logística<select value={operatorId} disabled={busy} onChange={(event) => setOperatorId(event.target.value)}>
        <option value="">Selecione</option>{operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.displayName}</option>)}</select></label>
      <button className="seller-button seller-primary" disabled={busy || !operatorId} onClick={() => void run('assign')}>
        {route.operatorId ? 'Reatribuir rota' : 'Atribuir rota'}</button></div>}
  </article>;
}

export function LogisticsPickupDashboard({ mode, embedded = false }: { mode: 'manager' | 'operator'; embedded?: boolean }) {
  const manager = mode === 'manager';
  const [date, setDate] = useState(() => localDate());
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [data, setData] = useState<LogisticsPickupList | null>(null);
  const [operators, setOperators] = useState<LogisticsOperatorList['operators']>([]);
  const [routes, setRoutes] = useState<ScrapCollectionRoute[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editingId, setEditingId] = useState('');
  const [selectedSchedules, setSelectedSchedules] = useState<string[]>([]);
  const [routeBusy, setRouteBusy] = useState(false);
  const focusAfter = useRef<string | null>(null);
  const generation = useRef(0);
  const blocked = useRef(false);
  const activeDate = useRef(date);
  const load = useCallback(async () => {
    if (blocked.current || activeDate.current !== date) return;
    const current = ++generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const user = await sellerClient.identity();
      if (!user.capabilities.includes(manager ? 'scrap.dispatch_pickups' : 'scrap.execute_pickups')) throw new Error('Seu perfil não tem acesso a esta rota de coletas.');
      const [result, available, planned] = await Promise.all([logisticsPickupsClient.list(date),
        manager ? logisticsPickupsClient.operators() : Promise.resolve({ operators: [] }),
        scrapCollectionRoutesClient.list(date)]);
      if (current === generation.current && !blocked.current) {
        setIdentity(user); setData(result); setOperators(available.operators); setRoutes(planned.routes);
      }
    } catch (failure) {
      if (current === generation.current && !blocked.current) { setData(null); setError(failure instanceof Error ? failure.message : 'Não foi possível consultar as coletas.'); }
    } finally { if (current === generation.current && !blocked.current) setBusy(false); }
  }, [date, manager]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => {
    if (!busy && data && focusAfter.current) {
      document.getElementById(`pickup-${focusAfter.current}`)?.focus();
      focusAfter.current = null;
    }
  }, [busy, data]);
  useEffect(() => observeLocalAccessRevocation(() => { blocked.current = true; generation.current++; setIdentity(null); setData(null); setOperators([]); setRoutes([]); setBusy(false); setError('A sessão mudou. Entre novamente para consultar a rota.'); }), []);
  const title = manager ? 'Coletas da logística' : 'Minha rota de coletas';
  async function createRoute() {
    if (!selectedSchedules.length || routeBusy) return;
    setRouteBusy(true); setError('');
    try {
      await scrapCollectionRoutesClient.create({ schemaVersion: 1, routeDate: date,
        scheduleIds: selectedSchedules }, crypto.randomUUID());
      setSelectedSchedules([]); await load(); setMessage('Sugestão de rota criada. Revise a ordem e aprove antes de atribuir.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível criar a rota.'); }
    finally { setRouteBusy(false); }
  }
  return <section className="logistics-dashboard" id="logistics-pickups" aria-label={title}>
    {embedded ? <h2>{title}</h2> : <h1>{title}</h1>}
    <p>{manager ? 'Distribua as paradas e compare a promessa do cliente com o peso realmente coletado. Pendências de dias anteriores também aparecem.' : 'Confira suas paradas e registre o resultado de cada coleta. A confirmação exige conexão.'}</p>
    {identity && !manager && <p>{identity.displayName}</p>}
    <div className="logistics-toolbar"><label>Dia das coletas<input type="date" disabled={Boolean(editingId) || busy} required value={date} onChange={(e) => { if (e.target.value) { activeDate.current = e.target.value; generation.current++; setData(null); setDate(e.target.value); } }} /></label><button type="button" disabled={busy || blocked.current || Boolean(editingId)} className="seller-button seller-secondary" onClick={() => void load()}>Atualizar coletas</button></div>
    {editingId && <p className="seller-muted">Confirme ou cancele o formulário aberto antes de trocar o dia ou atualizar a lista.</p>}
    {busy && <p role="status">Consultando a rota de coletas…</p>}
    {error && <p role="alert" className="seller-notice seller-error">{error} <a href="/login">Acessar login</a></p>}
    {message && <p role="status" className="seller-notice">{message}</p>}
    {data && !busy && <>
      {routes.map((route) => <section className="logistics-route-heading" key={route.routeId}
        aria-label={`Rota ${route.routeId}`}><p className="seller-kicker">ROTA {route.routeId}</p>
        <h2>{route.counts.completed} de {route.counts.total} coletas concluídas</h2>
        <p>{route.status === 'completed' ? 'Rota concluída' : route.status === 'in_progress' ? 'Rota em andamento'
          : route.status === 'assigned' ? 'Rota pronta para iniciar' : 'Rota em planejamento'}</p></section>)}
      {manager && <dl className="logistics-summary"><div><dt>Prometido nas paradas</dt><dd>{decimalKg(data.totals.promisedWeightKg)} kg</dd></div><div><dt>Coletado confirmado</dt><dd>{decimalKg(data.totals.collectedWeightKg)} kg</dd></div><div><dt>Diferença nas executadas</dt><dd>{decimalKg(data.totals.differenceKg)} kg</dd></div><div><dt>Aguardando coleta</dt><dd>{data.totals.pending}</dd></div><div><dt>Revisões pendentes</dt><dd>{data.totals.reviewRequired}</dd></div></dl>}
      {manager && <section className="logistics-route-planner"><h2>Planejar rota inteligente</h2>
        <p>Selecione promessas ainda não atribuídas. A ordem inicial usa proximidade aproximada e sempre exige sua aprovação.</p>
        <div className="logistics-route-selection">{data.records.filter((record) => !record.assignment && !record.result).map((record) =>
          <label key={record.scheduleId}><input type="checkbox" checked={selectedSchedules.includes(record.scheduleId)}
            onChange={(event) => setSelectedSchedules((current) => event.target.checked ? [...current, record.scheduleId]
              : current.filter((id) => id !== record.scheduleId))} />
            <span><strong>{record.client.name}</strong><small>{record.promisedWeightKg} kg · {record.client.address}</small></span></label>)}</div>
        <button type="button" className="seller-button seller-primary" disabled={!selectedSchedules.length || routeBusy}
          onClick={() => void createRoute()}>{routeBusy ? 'Criando sugestão…' : `Criar rota com ${selectedSchedules.length} parada(s)`}</button>
        <div className="logistics-pickup-list">{routes.map((route) => <CollectionRouteCard key={`${route.routeId}-${route.version}`}
          route={route} operators={operators} available={data.records.filter((record) => !record.assignment && !record.result)}
          onSaved={load} />)}</div></section>}
      {!data.records.length && <p role="status" className="seller-notice">{manager ? 'Nenhum agendamento pendente ou atribuído para este dia.' : 'Nenhuma parada atribuída a você para este dia. A rota aparecerá quando o gestor fizer a atribuição.'}</p>}
      <div className="logistics-pickup-list">{data.records.map((record) => <PickupCard key={`${record.scheduleId}-${record.version}`} record={record} operators={operators} manager={manager} date={date} interactionBlocked={Boolean(editingId) && editingId !== record.scheduleId} onEditChange={(editing) => setEditingId(editing ? record.scheduleId : '')} onSaved={async () => { focusAfter.current = record.scheduleId; await load(); if (!blocked.current && activeDate.current === date) setMessage('Registro confirmado no servidor.'); }} />)}</div>
      <p className="seller-muted">Atualizado em {timestampLabel(data.generatedAt)} · horário de Brasília. Promessas pendentes não entram na diferença de peso.</p>
    </>}
  </section>;
}
