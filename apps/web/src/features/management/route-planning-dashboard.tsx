'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  clientListResponseSchema,
  clientSellerListResponseSchema,
  clientSellersPath,
  clientsPath,
  routeDraftSchema,
  routeCompositionDraftSchema,
  routePlanningResponseSchema,
  routePublicationSchema,
  routesPath,
  type ClientListPagination,
  type ClientSeller,
  type ImportedClient,
  type RoutePlanningResponse,
} from '@cirne/contracts';
import { localDate, ScrapRequestError, scrapRequest } from '../scrap/scrap-ui';
import { ClientSalesDialog, SalesCoverage, cycleLabels, salesNumber } from '../clients/client-sales-dialog';
import { useSalesSignals } from '../clients/use-sales-signals';
import { observeLocalAccessRevocation } from '../../lib/offline/access-revocation';
import { ClientLocationSource } from '../clients/client-location-source';

const pageSize = 25;
const emptyPagination: ClientListPagination = {
  page: 1, pageSize, totalCount: 0, totalPages: 0, hasPrevious: false, hasNext: false,
};

type PlanningClient = {
  id: string;
  externalReference: string | null;
  name: string;
  address: string;
  portfolioReference: string | null;
  googleLocation?: ImportedClient['googleLocation'];
};
type PlannedStop = { client: PlanningClient; priority: number };
type PlanningContext = { serviceDate: string; sellerId: string };

function planningFailureMessage(error: unknown) {
  if (error instanceof ScrapRequestError && error.status === 401) return 'Entre novamente para consultar o planejamento.';
  if (error instanceof ScrapRequestError && error.status === 403) return 'Seu perfil não tem permissão para consultar este planejamento.';
  return 'Não foi possível carregar o planejamento. Sua última composição continua nesta tela; tente novamente.';
}

function clientListFailureMessage(error: unknown, fallback: string) {
  if (error instanceof ScrapRequestError && (error.status === 401 || error.status === 403)) return error.message;
  return fallback;
}

function requestHeaders(idempotencyKey?: string) {
  return {
    'content-type': 'application/json',
    'x-csrf-token': 'cirne-route-v1',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

function planningUrl(serviceDate: string, sellerId: string) {
  return `${routesPath}?${new URLSearchParams({ serviceDate, sellerId })}`;
}

function clientsUrl(sellerId: string, query: string, page: number) {
  const parameters = new URLSearchParams({ sellerId, page: String(page), pageSize: String(pageSize) });
  if (query.trim()) parameters.set('q', query.trim());
  return `${clientsPath}?${parameters}`;
}

function validServiceDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formattedServiceDate(value: string) {
  if (!validServiceDate(value)) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' })
    .format(new Date(`${value}T12:00:00Z`));
}

function stateLabel(planning: RoutePlanningResponse | null) {
  if (!planning || planning.availability === 'empty') return 'Sem rota';
  if (planning.route.state === 'initial_draft') return 'Rascunho não publicado';
  if (planning.route.state === 'successor_draft') return 'Revisão em rascunho';
  return 'Rota publicada';
}

export function RoutePlanningDashboard({ initialServiceDate }: { initialServiceDate?: string } = {}) {
  const [sellers, setSellers] = useState<ClientSeller[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [serviceDate, setServiceDate] = useState(() => (
    initialServiceDate && validServiceDate(initialServiceDate) ? initialServiceDate : localDate()
  ));
  const [planning, setPlanning] = useState<RoutePlanningResponse | null>(null);
  const [composition, setComposition] = useState<PlannedStop[]>([]);
  const [clients, setClients] = useState<ImportedClient[]>([]);
  const [pagination, setPagination] = useState<ClientListPagination>(emptyPagination);
  const [searchInput, setSearchInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [listBusy, setListBusy] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingContext, setPendingContext] = useState<PlanningContext | null>(null);
  const [conflict, setConflict] = useState(false);
  const [planningError, setPlanningError] = useState(false);
  const [message, setMessage] = useState('');
  const [salesClient, setSalesClient] = useState<{ client: PlanningClient } | null>(null);
  const [signalSort, setSignalSort] = useState('original');
  const [salesLocked, setSalesLocked] = useState(false);
  const planningRequestRef = useRef(0);
  const clientsRequestRef = useRef(0);
  const reviewDialogRef = useRef<HTMLDialogElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const contextDialogRef = useRef<HTMLDialogElement>(null);
  const contextTriggerRef = useRef<HTMLElement | null>(null);
  const signals = useSalesSignals(sellerId, serviceDate, clients.map((client) => client.id), !loading && !listBusy && !salesLocked);
  const visibleClients = useMemo(() => {
    if (!signals.data || signalSort === 'original') return clients;
    const byId = new Map(signals.data.signals.map((signal) => [signal.client.id, signal.metrics]));
    return [...clients].sort((a, b) => {
      const left = byId.get(a.id); const right = byId.get(b.id);
      const leftValue = signalSort === 'recency' ? left?.daysSinceLastPurchase : left?.averageMonthlyVolume;
      const rightValue = signalSort === 'recency' ? right?.daysSinceLastPurchase : right?.averageMonthlyVolume;
      if (leftValue == null) return rightValue == null ? a.id.localeCompare(b.id) : 1;
      if (rightValue == null) return -1;
      return rightValue - leftValue || a.id.localeCompare(b.id);
    });
  }, [clients, signals.data, signalSort]);
  useEffect(() => observeLocalAccessRevocation(() => { setSalesClient(null); setSalesLocked(true); }), []);
  useEffect(() => { setSalesClient(null); setSignalSort('original'); }, [sellerId, serviceDate, appliedQuery, pagination.page]);

  function openSales(client: PlanningClient) {
    if (salesLocked) return;
    setSalesClient({ client });
  }

  const route = planning?.availability === 'available' ? planning.route : null;
  const selectedIds = useMemo(() => new Set(composition.map((stop) => stop.client.id)), [composition]);
  const compositionPersisted = useMemo(() => Boolean(route)
    && route!.stops.length === composition.length
    && route!.stops.every((stop, index) => stop.client.id === composition[index]?.client.id
      && stop.priority === composition[index]?.priority
      && stop.plannedOrder === index + 1)
    && (route!.state === 'initial_draft' || (route!.changeReason ?? '') === reason.trim()),
  [composition, reason, route]);
  const hasUnsavedChanges = route ? !compositionPersisted : composition.length > 0 || reason.trim().length > 0;

  const applyPlanning = useCallback((result: RoutePlanningResponse) => {
    setPlanning(result);
    setComposition(result.availability === 'available'
      ? result.route.stops.map((stop) => ({ client: stop.client, priority: stop.priority }))
      : []);
    setReason(result.availability === 'available' ? result.route.changeReason ?? '' : '');
    setConflict(false);
    setPlanningError(false);
  }, []);

  const loadPlanning = useCallback(async (date: string, selectedSeller: string) => {
    const requestId = ++planningRequestRef.current;
    const result = routePlanningResponseSchema.parse(
      await scrapRequest(planningUrl(date, selectedSeller)),
    );
    if (requestId === planningRequestRef.current) applyPlanning(result);
    return result;
  }, [applyPlanning]);

  const loadClients = useCallback(async (selectedSeller: string, query: string, page: number) => {
    const requestId = ++clientsRequestRef.current;
    const result = clientListResponseSchema.parse(
      await scrapRequest(clientsUrl(selectedSeller, query, page)),
    );
    if (requestId === clientsRequestRef.current) {
      setClients(result.clients);
      setAppliedQuery(result.query);
      setPagination(result.pagination);
    }
    return result;
  }, []);

  useEffect(() => {
    if (!reviewOpen) return;
    const dialog = reviewDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => dialog.querySelector<HTMLButtonElement>('button')?.focus(), 0);
    return () => {
      if (dialog.open) dialog.close();
      window.setTimeout(() => reviewTriggerRef.current?.focus(), 0);
    };
  }, [reviewOpen]);

  useEffect(() => {
    if (!pendingContext) return;
    const dialog = contextDialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => dialog.querySelector<HTMLButtonElement>('button')?.focus(), 0);
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [pendingContext]);

  function requestContextChange(next: PlanningContext) {
    if (next.serviceDate === serviceDate && next.sellerId === sellerId) return;
    if (hasUnsavedChanges) {
      contextTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPendingContext(next);
      return;
    }
    setServiceDate(next.serviceDate);
    setSellerId(next.sellerId);
  }

  function keepEditingContext() {
    setPendingContext(null);
    window.setTimeout(() => contextTriggerRef.current?.focus(), 0);
  }

  function discardAndChangeContext() {
    if (!pendingContext) return;
    const next = pendingContext;
    setPendingContext(null);
    setServiceDate(next.serviceDate);
    setSellerId(next.sellerId);
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = clientSellerListResponseSchema.parse(await scrapRequest(clientSellersPath));
        if (!active) return;
        setSellers(result.sellers);
        setSellerId(result.sellers[0]?.id ?? '');
        if (result.sellers.length === 0) setMessage('Nenhum vendedor ativo está disponível na sua abrangência.');
      } catch (error) {
        if (active) setMessage(clientListFailureMessage(error, 'Não foi possível consultar os vendedores.'));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sellerId) return;
    if (!validServiceDate(serviceDate)) {
      planningRequestRef.current += 1;
      clientsRequestRef.current += 1;
      setPlanning(null);
      setComposition([]);
      setClients([]);
      setPagination(emptyPagination);
      setLoading(false);
      setReviewOpen(false);
      setMessage('Informe uma data válida para consultar o planejamento.');
      return;
    }
    let active = true;
    setLoading(true); setMessage(''); setReviewOpen(false); setPlanningError(false);
    void Promise.allSettled([loadPlanning(serviceDate, sellerId), loadClients(sellerId, '', 1)])
      .then(([planningResult, clientsResult]) => {
        if (!active) return;
        if (planningResult.status === 'rejected') {
          setPlanningError(true);
          setMessage(planningFailureMessage(planningResult.reason));
          return;
        }
        if (clientsResult.status === 'rejected') {
          setMessage(clientListFailureMessage(clientsResult.reason, 'Não foi possível carregar a carteira deste vendedor.'));
        }
      }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      planningRequestRef.current += 1;
      clientsRequestRef.current += 1;
    };
  }, [loadClients, loadPlanning, sellerId, serviceDate]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!sellerId) return;
    setListBusy(true); setMessage('');
    try { await loadClients(sellerId, searchInput, 1); }
    catch (error) { setMessage(clientListFailureMessage(error, 'Não foi possível pesquisar clientes.')); }
    finally { setListBusy(false); }
  }

  async function showPage(page: number) {
    if (!sellerId) return;
    setListBusy(true); setMessage('');
    try { await loadClients(sellerId, appliedQuery, page); }
    catch (error) { setMessage(clientListFailureMessage(error, 'Não foi possível carregar a página.')); }
    finally { setListBusy(false); }
  }

  function addClient(client: ImportedClient) {
    if (selectedIds.has(client.id) || composition.length >= 50) return;
    setComposition((current) => [...current, { client, priority: 0 }]);
    setMessage(''); setConflict(false);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= composition.length) return;
    setComposition((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setConflict(false);
  }

  function payloadStops() {
    return composition.map((stop, index) => ({
      clientId: stop.client.id,
      plannedOrder: index + 1,
      priority: stop.priority,
    }));
  }

  async function saveDraft() {
    if (!sellerId || composition.length === 0) {
      setMessage('Inclua ao menos um cliente antes de salvar.');
      return;
    }
    if (route && route.state !== 'initial_draft' && reason.trim().length === 0) {
      setMessage('Informe o motivo da alteração após a publicação.');
      return;
    }
    setMutating(true); setMessage(''); setConflict(false);
    try {
      const stops = payloadStops();
      if (!route) {
        routeDraftSchema.parse(await scrapRequest(routesPath, {
          method: 'POST', headers: requestHeaders(),
          body: JSON.stringify({ schemaVersion: 1, serviceDate, sellerId, stops }),
        }));
      } else {
        routeDraftSchema.or(routeCompositionDraftSchema).parse(await scrapRequest(`${routesPath}/${route.routeId}`, {
          method: 'PATCH', headers: requestHeaders(crypto.randomUUID()),
          body: JSON.stringify(route.state === 'initial_draft'
            ? { schemaVersion: 1, expectedVersion: route.expectedVersion, stops }
            : { schemaVersion: 1, expectedVersion: route.expectedVersion, reason: reason.trim(), stops }),
        }));
      }
      await loadPlanning(serviceDate, sellerId);
      setMessage(route ? 'Rascunho atualizado e preservado no servidor.' : 'Rascunho criado e preservado no servidor.');
    } catch (error) {
      if (error instanceof ScrapRequestError && error.status === 409) {
        setConflict(true);
        setMessage('Outra alteração chegou ao servidor. Sua composição continua nesta tela; compare antes de recarregar.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Não foi possível salvar o rascunho.');
      }
    } finally { setMutating(false); }
  }

  async function publish() {
    if (!route || !compositionPersisted) {
      setReviewOpen(false);
      setMessage('Salve as alterações antes de publicar a rota.');
      return;
    }
    setMutating(true); setMessage('');
    try {
      routePublicationSchema.parse(await scrapRequest(`${routesPath}/${route.routeId}/publish`, {
        method: 'POST', headers: requestHeaders(),
        body: JSON.stringify({ schemaVersion: 1, expectedVersion: route.expectedVersion }),
      }));
      await loadPlanning(serviceDate, sellerId);
      setReviewOpen(false);
      setMessage('Rota publicada e disponibilizada para o vendedor.');
    } catch (error) {
      if (error instanceof ScrapRequestError && error.status === 409) {
        setConflict(true);
        setReviewOpen(false);
        setMessage('A rota mudou antes da publicação. Sua composição continua nesta tela; recarregue para comparar.');
      } else {
        setMessage(error instanceof Error ? error.message : 'Não foi possível publicar a rota.');
      }
    } finally { setMutating(false); }
  }

  async function retryPlanning() {
    if (!sellerId || !validServiceDate(serviceDate)) return;
    setLoading(true); setMessage('');
    try {
      await loadPlanning(serviceDate, sellerId);
      setMessage('Planejamento atualizado.');
    } catch (error) {
      setPlanningError(true);
      setMessage(planningFailureMessage(error));
    } finally {
      setLoading(false);
    }
  }


  const canPublish = route?.state === 'initial_draft' || route?.state === 'successor_draft';
  const canReviewPublish = canPublish && compositionPersisted;

  return <main className="route-planner-page">
    <header className="route-planner-heading">
      <div><p className="manager-eyebrow">PLANEJAMENTO OPERACIONAL</p><h1>Planejar rotas</h1>
        <p>Monte, revise e publique a sequência diária de cada vendedor.</p></div>
      {validServiceDate(serviceDate)
        ? <a className="manager-link-button" href={`/management/day?serviceDate=${serviceDate}`}>Abrir Central do dia</a>
        : <span className="manager-link-button" aria-disabled="true">Abrir Central do dia</span>}
    </header>

    <section className="route-planner-filters" aria-label="Seleção do planejamento">
      <label>Data da rota<input type="date" value={serviceDate} onChange={(event) => requestContextChange({ serviceDate: event.target.value, sellerId })} disabled={mutating} /></label>
      <label>Vendedor<select value={sellerId} onChange={(event) => requestContextChange({ serviceDate, sellerId: event.target.value })} disabled={mutating || sellers.length === 0}>
        {sellers.length === 0 && <option value="">Nenhum vendedor disponível</option>}
        {sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.displayName}</option>)}
      </select></label>
      <div className="route-planner-state"><span>Estado</span><strong>{loading ? 'Carregando…' : planningError ? 'Falha ao consultar' : stateLabel(planning)}</strong>
        {route && <small>Versão {route.versionNumber} · controle {route.expectedVersion}</small>}</div>
    </section>

    {message && <p className={`route-planner-message${conflict ? ' is-conflict' : ''}`} role={conflict ? 'alert' : 'status'}>{message}</p>}
    {conflict && <button type="button" className="manager-link-button" onClick={() => void loadPlanning(serviceDate, sellerId)} disabled={mutating}>Recarregar versão do servidor</button>}
    {planningError && <button type="button" className="manager-link-button" onClick={() => void retryPlanning()} disabled={loading || mutating}>Tentar carregar novamente</button>}

    <nav className="route-planner-shortcuts" aria-label="Atalhos do planejamento">
      <a href="#available-clients-title">Carteira</a>
      <a href="#composition-title">Composição</a>
      <a href="#planning-actions-title">Salvar e publicar</a>
    </nav>

    <div className="route-planner-workspace" aria-busy={loading || mutating}>
      <section className="route-planner-clients" aria-labelledby="available-clients-title">
        <div className="route-planner-section-title"><div><p>CARTEIRA</p><h2 id="available-clients-title">Clientes disponíveis</h2></div><span>{pagination.totalCount}</span></div>
        <form role="search" onSubmit={search} className="route-planner-search">
          <label className="sr-only" htmlFor="route-client-search">Pesquisar clientes</label>
          <input id="route-client-search" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Nome, referência ou endereço" />
          <button type="submit" disabled={listBusy}>Buscar</button>
        </form>
        {listBusy && <p role="status">Atualizando carteira…</p>}
        <div className="client-sales-planner-controls" aria-busy={signals.busy}>
          <label>Ordenar esta página<select value={signalSort} disabled={!signals.data} onChange={(event) => setSignalSort(event.target.value)}>
            <option value="original">Ordem da carteira</option><option value="recency">Mais dias desde a compra</option><option value="volume">Maior média mensal</option>
          </select></label>
          <p>Consulta somente os clientes desta página. A composição, a prioridade e a publicação permanecem nos controles existentes.</p>
          {signals.busy && <p role="status">Consultando sinais de compras…</p>}
          {signals.message && <p role="status">{signals.message}</p>}
          {!signals.busy && !signals.locked && <button type="button" className="manager-link-button" onClick={signals.reload} disabled={loading || listBusy || clients.length === 0}>Atualizar sinais</button>}
          {signals.data && <SalesCoverage data={signals.data} />}
        </div>
        {!listBusy && clients.length === 0 && <p className="route-planner-empty">Nenhum cliente ativo encontrado nesta carteira.</p>}
        <ul className="route-planner-client-list">
          {visibleClients.map((client) => { const metric = signals.data?.signals.find((signal) => signal.client.id === client.id)?.metrics;
            return <li key={client.id}><div><strong><button type="button" className="client-sales-trigger" disabled={salesLocked} aria-label={`Consultar compras de ${client.name}`} onClick={() => openSales(client)}>{client.name}</button></strong><span>{client.externalReference} · {client.portfolioReference ?? 'Sem carteira informada'}</span><small>{client.address}</small>
              <ClientLocationSource location={client.googleLocation} />
              {metric && <p className="client-sales-signal"><strong>{cycleLabels[metric.cycleState]}</strong><br />
                {metric.daysSinceLastPurchase === null ? 'Sem compra positiva registrada' : `${metric.daysSinceLastPurchase} dias desde a compra`} · ciclo {metric.periodicityDays === null ? 'insuficiente' : `${salesNumber(metric.periodicityDays)} dias`} ({metric.positivePurchaseDateCount} datas)<br />
                Média {salesNumber(metric.averageMonthlyVolume)} un./mês · volume líquido {salesNumber(metric.netVolume6)} un. nos seis meses completos.</p>}
              </div>
            <button type="button" onClick={() => addClient(client)} disabled={selectedIds.has(client.id) || composition.length >= 50}>
              {selectedIds.has(client.id) ? 'Incluído' : 'Adicionar'}
            </button></li>; })}
        </ul>
        <div className="route-planner-pagination"><button type="button" disabled={!pagination.hasPrevious || listBusy} onClick={() => void showPage(pagination.page - 1)}>Anterior</button><span>Página {pagination.page} de {Math.max(pagination.totalPages, 1)}</span><button type="button" disabled={!pagination.hasNext || listBusy} onClick={() => void showPage(pagination.page + 1)}>Próxima</button></div>
      </section>

      <section className="route-planner-composition" aria-labelledby="composition-title">
        <div className="route-planner-section-title"><div><p>SEQUÊNCIA DO DIA</p><h2 id="composition-title">Composição da rota</h2></div><span>{composition.length}/50</span></div>
        {composition.length === 0 && <div className="route-planner-empty"><strong>A rota ainda está vazia.</strong><p>Adicione clientes da carteira ao lado para começar.</p></div>}
        <ol className="route-planner-stop-list">
          {composition.map((stop, index) => <li key={stop.client.id}>
            <span className="route-planner-order" aria-label={`Parada ${index + 1}`}>{index + 1}</span>
            <div className="route-planner-stop-info"><strong><button type="button" className="client-sales-trigger" disabled={salesLocked} aria-label={`Consultar compras de ${stop.client.name}`} onClick={() => openSales(stop.client)}>{stop.client.name}</button></strong><span>{stop.client.externalReference ?? 'Sem referência'} · {stop.client.address}</span><ClientLocationSource location={stop.client.googleLocation} /></div>
            <label>Prioridade<select aria-label={`Prioridade de ${stop.client.name}`} value={stop.priority} onChange={(event) => setComposition((current) => current.map((item, position) => position === index ? { ...item, priority: Number(event.target.value) } : item))}>{Array.from({ length: 10 }, (_, value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <div className="route-planner-stop-actions">
              <button type="button" aria-label={`Mover ${stop.client.name} para cima`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={`Mover ${stop.client.name} para baixo`} disabled={index === composition.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="is-danger" aria-label={`Remover ${stop.client.name}`} onClick={() => { setComposition((current) => current.filter((_, position) => position !== index)); setConflict(false); }}>Remover</button>
            </div>
          </li>)}
        </ol>
      </section>

      <aside className="route-planner-actions" aria-labelledby="planning-actions-title">
        <p>CONTROLE</p><h2 id="planning-actions-title">Salvar e publicar</h2>
        <dl><div><dt>Data</dt><dd>{formattedServiceDate(serviceDate)}</dd></div><div><dt>Vendedor</dt><dd>{sellers.find((seller) => seller.id === sellerId)?.displayName ?? '—'}</dd></div><div><dt>Paradas</dt><dd>{composition.length}</dd></div></dl>
        {route && route.state !== 'initial_draft' && <label>Motivo da alteração<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={4} placeholder="Explique a revisão após a publicação" /></label>}
        <button type="button" className="route-planner-save" onClick={() => void saveDraft()} disabled={mutating || loading || composition.length === 0}>{mutating ? 'Processando…' : route?.state === 'published' ? 'Criar revisão' : 'Salvar rascunho'}</button>
        {canPublish && <button ref={reviewTriggerRef} type="button" className="route-planner-publish" onClick={() => setReviewOpen(true)} disabled={mutating || conflict || !canReviewPublish}>Revisar e publicar</button>}
        {canPublish && !compositionPersisted && <p className="route-planner-help">Salve a composição atual antes de revisar a publicação.</p>}
        {route?.state === 'published' && <p className="route-planner-help">Esta versão já está com o vendedor. Altere a composição, informe o motivo e crie uma revisão para publicar novamente.</p>}
      </aside>
    </div>

    {salesClient && <ClientSalesDialog key={salesClient.client.id} client={salesClient.client} onClose={() => setSalesClient(null)} />}
    {reviewOpen && route && <dialog ref={reviewDialogRef} className="route-planner-review" aria-labelledby="route-review-title" onCancel={(event) => { event.preventDefault(); if (!mutating) setReviewOpen(false); }}>
        <p>CONFIRMAÇÃO</p><h2 id="route-review-title">Publicar esta rota?</h2>
        <p><strong>{composition.length} paradas</strong> para <strong>{route.seller.displayName}</strong> em {serviceDate}.</p>
        <ol>{composition.map((stop, index) => <li key={stop.client.id}><span>{index + 1}</span>{stop.client.name}<small>prioridade {stop.priority}</small></li>)}</ol>
        <p>Após confirmar, a rota ficará disponível para execução pelo vendedor.</p>
        <div><button type="button" onClick={() => setReviewOpen(false)} disabled={mutating}>Voltar e revisar</button><button type="button" className="route-planner-publish" onClick={() => void publish()} disabled={mutating}>{mutating ? 'Publicando…' : 'Confirmar publicação'}</button></div>
    </dialog>}

    {pendingContext && <dialog ref={contextDialogRef} className="route-planner-review route-planner-discard-dialog" aria-labelledby="route-discard-title" onCancel={(event) => { event.preventDefault(); keepEditingContext(); }}>
      <p>ALTERAÇÕES NÃO SALVAS</p><h2 id="route-discard-title">Trocar o planejamento?</h2>
      <p>Você alterou a composição desta rota. Para mudar a data ou o vendedor, confirme que deseja descartar essas alterações locais.</p>
      <div><button type="button" onClick={keepEditingContext}>Continuar editando</button><button type="button" className="route-planner-discard" onClick={discardAndChangeContext}>Descartar alterações</button></div>
    </dialog>}
  </main>;
}
