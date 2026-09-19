'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CanonicalRoute, LocalVisitDraft, MeResponse, RouteTodayResponse } from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';
import { SavedVisits } from '@/features/visits/saved-visits';
import { OfflineFoundationService } from '@/lib/offline/service';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { isSessionFailure, sellerClient, SellerHttpError } from '@/lib/seller-client';
import { formatServiceDate, movePending, orderedStops, pendingIds, routeProgress } from './route-model';
import { NavigationActions } from './navigation-actions';

const statusLabels = { pending: 'Pendente', in_visit: 'Em visita', completed: 'Visitado', not_visited: 'Não visitado' };

export function RouteScreen() {
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [today, setToday] = useState<RouteTodayResponse | null>(null);
  const [draft, setDraft] = useState<CanonicalRoute['stops'] | null>(null);
  const [busy, setBusy] = useState(true);
  const [loginRequired, setLoginRequired] = useState(false);
  const [message, setMessage] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [offline, setOffline] = useState(false);
  const [offlineCache, setOfflineCache] = useState<'saving' | 'ready' | 'unavailable' | null>(null);
  const [compositionMessage, setCompositionMessage] = useState('');
  const [visitDrafts, setVisitDrafts] = useState<Record<string, LocalVisitDraft>>({});
  const [visitBusyStop, setVisitBusyStop] = useState<string | null>(null);
  const generation = useRef(0);
  const accessBlocked = useRef(false);
  const cacheGeneration = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const offlineService = useRef<OfflineFoundationService | null>(null);

  const clearPrivate = useCallback(() => {
    ++cacheGeneration.current;
    setIdentity(null); setToday(null); setDraft(null); setOfflineCache(null); setCompositionMessage(''); setVisitDrafts({});
  }, []);
  const cacheRoute = useCallback((userId: string, route: CanonicalRoute, current: number) => {
    const service = offlineService.current;
    if (!service) return;
    const currentCache = ++cacheGeneration.current;
    setOfflineCache('saving');
    void service.cacheCanonicalRoute(userId, route)
      .then(async ({ availableOffline, bundle, compositionUpdated }) => {
        if (current === generation.current && currentCache === cacheGeneration.current) {
          setOfflineCache(availableOffline ? 'ready' : 'unavailable');
          if (compositionUpdated && bundle.schemaVersion === 3 && bundle.compositionChange) {
            const { reason, added, removed } = bundle.compositionChange;
            setCompositionMessage(
              `Rota atualizada pelo Gestor: ${added.length} incluído${added.length === 1 ? '' : 's'} e ` +
              `${removed.length} retirado${removed.length === 1 ? '' : 's'}. Motivo: ${reason}`,
            );
          }
          const snapshot = await service.refresh({ userId, deviceId: bundle.deviceId });
          if (current === generation.current && currentCache === cacheGeneration.current) {
            setVisitDrafts(Object.fromEntries(snapshot.kind === 'ready'
              ? snapshot.drafts.filter((visit) => visit.deviceStartedAt).map((visit) => [visit.routeVersionStopId, visit])
              : []));
          }
        }
      })
      .catch(() => {
        if (current === generation.current && currentCache === cacheGeneration.current) {
          setOfflineCache('unavailable');
        }
      });
  }, []);
  const load = useCallback(async () => {
    if (accessBlocked.current) return;
    const current = ++generation.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    clearPrivate(); setBusy(true); setMessage(''); setLoginRequired(false); setNeedsReload(false);
    try {
      const user = await sellerClient.identity(active.signal);
      if (!user.roles.includes('seller') || !user.capabilities.includes('route.read_self')) throw new SellerHttpError(403);
      const result = await sellerClient.today(active.signal);
      if (result.availability === 'available' && result.route.seller.id !== user.id) throw new SellerHttpError(403);
      if (current !== generation.current) return;
      setIdentity(user); setToday(result);
      if (result.availability === 'available') cacheRoute(user.id, result.route, current);
    } catch (error) {
      if (current !== generation.current) return;
      if (isSessionFailure(error)) setLoginRequired(true);
      else setMessage('Não foi possível carregar sua rota. Confira a conexão e tente novamente.');
    } finally { if (current === generation.current) setBusy(false); }
  }, [cacheRoute, clearPrivate]);

  useEffect(() => {
    const localService = new OfflineFoundationService();
    offlineService.current = localService;
    accessBlocked.current = false;
    const stopObserving = observeLocalAccessRevocation(() => {
      accessBlocked.current = true;
      ++generation.current;
      controller.current?.abort();
      localService.blockLocalAccess();
      clearPrivate();
      setLoginRequired(true); setBusy(false); setMessage(''); setVisitBusyStop(null);
    });
    void load();
    const connectivity = () => setOffline(!navigator.onLine);
    connectivity();
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void load(); };
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    window.addEventListener('pageshow', restored);
    return () => {
      ++generation.current; controller.current?.abort(); stopObserving();
      localService.close();
      if (offlineService.current === localService) offlineService.current = null;
      window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity);
      window.removeEventListener('pageshow', restored);
    };
  }, [load, clearPrivate]);

  async function logout() {
    accessBlocked.current = true;
    ++generation.current; controller.current?.abort(); clearPrivate(); setBusy(true); setMessage('');
    try {
      try { await offlineService.current?.revokeLocalAccess(identity?.id); } catch { /* Private UI is already hidden; remote logout must still run. */ }
      await sellerClient.logout();
      window.location.replace('/login');
    }
    catch { setLoginRequired(true); setMessage('Os dados foram ocultados. Reconecte-se e tente sair novamente para confirmar o encerramento da sessão.'); setBusy(false); }
  }

  async function save() {
    if (!today || today.availability !== 'available' || !draft || busy || needsReload) return;
    const current = generation.current;
    setBusy(true); setMessage('');
    let accepted = false;
    try {
      await sellerClient.reorder(today.route, pendingIds(draft));
      accepted = true;
      const refreshed = await sellerClient.today();
      if (current !== generation.current) return;
      if (refreshed.availability === 'available' && refreshed.route.seller.id !== identity?.id) throw new SellerHttpError(403);
      setToday(refreshed); setDraft(null); setMessage('Ordem salva e confirmada no servidor.');
      if (refreshed.availability === 'available' && identity) cacheRoute(identity.id, refreshed.route, current);
    } catch (error) {
      if (current !== generation.current) return;
      if (isSessionFailure(error)) { clearPrivate(); setLoginRequired(true); setMessage('Seu acesso precisa ser validado novamente.'); }
      else if (error instanceof SellerHttpError && error.status === 409) {
        setNeedsReload(true); setMessage('A rota mudou no servidor. Recarregue a rota antes de reorganizar. Seu rascunho não foi aplicado.');
      } else {
        setNeedsReload(accepted);
        setMessage(accepted ? 'O envio foi aceito, mas a confirmação não pôde ser carregada. Recarregue a rota.'
          : 'Não foi possível confirmar o salvamento. Seu rascunho continua nesta tela. Confira a conexão.');
      }
    } finally { if (current === generation.current) setBusy(false); }
  }

  async function beginVisit(stop: CanonicalRoute['stops'][number]) {
    if (accessBlocked.current || !identity || !offlineService.current || visitBusyStop) return;
    const current = generation.current;
    const existing = visitDrafts[stop.routeVersionStopId];
    if (existing) {
      window.location.assign(`/visit/${existing.offlineId}?step=${existing.currentStep}`);
      return;
    }
    setVisitBusyStop(stop.routeVersionStopId);
    setMessage('');
    try {
      const result = await offlineService.current.startVisit({
        userId: identity.id,
        routeVersionStopId: stop.routeVersionStopId,
      });
      if (current !== generation.current || accessBlocked.current) return;
      setVisitDrafts((current) => ({ ...current, [stop.routeVersionStopId]: result.draft }));
      window.location.assign(`/visit/${result.draft.offlineId}?step=${result.draft.currentStep}`);
    } catch {
      if (current !== generation.current || accessBlocked.current) return;
      setMessage('Não foi possível salvar o início da visita neste aparelho. A parada continua inalterada.');
      setVisitBusyStop(null);
    }
  }

  const route = today?.availability === 'available' ? today.route : null;
  const stops = orderedStops(draft ?? route?.stops ?? []);
  const pending = pendingIds(stops);
  const progress = routeProgress(stops);
  const date = route?.serviceDate ?? (today?.availability === 'empty' ? today.serviceDate : null);
  const canReorder = identity?.capabilities.includes('route.reorder_self');

  return <div className="seller-app seller-route-page">
    <header className="seller-topbar"><div className="seller-topbar-inner"><Brand />
      <div className="seller-account">{identity && <><span className="seller-avatar" aria-hidden="true">{identity.displayName.slice(0, 1)}</span><span className="seller-account-name">{identity.displayName}<small>Vendedor</small></span></>}
        <button className="seller-button seller-quiet" onClick={() => void logout()} disabled={busy}>Sair</button>
      </div></div></header>
    <main className="seller-route-main" id="main-content" aria-busy={busy}>
      <div className="seller-title-row"><div><p className="seller-kicker">SEU DIA EM CAMPO</p><h1>Minha rota de hoje<span className="seller-heading-dot">.</span></h1>
        <p className="seller-muted">{date ? formatServiceDate(date) : 'Organize suas próximas paradas.'}</p>
        {identity && <p className="seller-owner">{identity.displayName}</p>}</div>
        <span className={`seller-connection${offline ? ' is-offline' : ''}`}><span aria-hidden="true">●</span> {offline ? 'Sem conexão' : 'Consulta online'}</span>
      </div>
      {offline && <p className="seller-notice" role="status">Sem conexão. A rota já aberta continua consultável; atualização, reordenação, salvamento e Google Maps precisam de internet.</p>}
      {offlineCache === 'unavailable' && !offline && <p className="seller-notice">A rota está disponível nesta tela, mas a cópia offline não pôde ser confirmada. Mantenha a conexão e tente atualizar novamente.</p>}
      {compositionMessage && <p className="seller-notice" role="status">{compositionMessage}</p>}
      {message && <div className="seller-notice" role="status">{message}</div>}
      {busy && !today && <div className="seller-state" role="status"><span className="seller-loading" aria-hidden="true" /><h2>Preparando seu dia…</h2><p>Validando seu acesso e buscando a rota publicada.</p></div>}
      {!busy && loginRequired && <section className="seller-state"><span className="seller-state-icon" aria-hidden="true">↗</span><h2>Entre para ver sua rota</h2><p>Use sua conta de vendedor para acessar o roteiro do dia.</p><a className="seller-button seller-primary" href="/login">Ir para o login</a></section>}
      {!busy && !loginRequired && !today && <section className="seller-state"><h2>Vamos tentar de novo?</h2><p>A indisponibilidade não significa que você está sem rota.</p><button className="seller-button seller-primary" onClick={() => void load()}>Tentar novamente</button></section>}
      {today?.availability === 'empty' && <section className="seller-state"><span className="seller-state-icon" aria-hidden="true">☷</span><h2>Nenhuma rota publicada para hoje</h2><p>Assim que sua rota for publicada, as paradas aparecerão aqui. Consulte seu gestor.</p><button className="seller-button seller-primary" onClick={() => void load()} disabled={busy}>Atualizar rota</button></section>}
      {route && <div className="seller-route-layout">
        <aside className="seller-overview" aria-label="Resumo do dia">
          <section className="seller-progress"><p className="seller-kicker">PROGRESSO DO DIA</p><div className="seller-progress-inner">
            <div><strong>{progress.completed} <span>de {progress.total}</span></strong><p>clientes visitados</p></div>
            <div className="seller-ring" style={{ '--progress': `${progress.percent}%` } as CSSProperties} aria-label={`${progress.percent}% das visitas concluídas`}><span>{progress.percent}<small>%</small></span></div>
          </div><div className="seller-progress-bottom"><span>{pending.length} parada{pending.length !== 1 ? 's' : ''} pendente{pending.length !== 1 ? 's' : ''}</span><span>Rota publicada <span aria-hidden="true">✓</span></span></div></section>
          <div className="seller-route-tip"><span className="seller-tip-icon" aria-hidden="true">↕</span><div><h2>Seu roteiro, na melhor ordem</h2><p>Reorganize as paradas pendentes e salve antes de seguir. Visitas já iniciadas ou encerradas mantêm sua posição.</p></div></div>
          <p className="seller-version">Versão da execução {route.executionVersion} · Consulta online<br />{
            offlineCache === 'ready' ? 'Disponível offline neste aparelho.'
              : offlineCache === 'saving' ? 'Preparando a cópia offline…'
                : 'Cópia offline ainda não confirmada.'
          }</p>
        </aside>
        <section className="seller-stops" aria-labelledby="stops-title">
          <div className="seller-section-heading"><div><h2 id="stops-title">Paradas do dia <span>{stops.length}</span></h2><p>{draft ? 'Ajuste a sequência usando as setas.' : 'Seu roteiro na ordem de execução.'}</p></div>
            {!draft && <button className="seller-button seller-secondary" disabled={busy || offline || needsReload || !canReorder || pending.length < 2} onClick={() => { setDraft(route.stops); setMessage(''); }}>Reordenar <span aria-hidden="true">↕</span></button>}
          </div>
          {(draft || needsReload) && <div className="seller-editbar"><span>{needsReload ? 'Recarregamento necessário' : 'Editando · alterações não salvas'}</span><div>
            {needsReload ? <button className="seller-button seller-primary" disabled={busy || offline} onClick={() => void load()}>Recarregar rota</button> : <>
              <button className="seller-button seller-secondary" disabled={busy} onClick={() => { setDraft(null); setMessage('Alterações descartadas.'); }}>Cancelar</button>
              <button className="seller-button seller-primary" disabled={busy || offline} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar ordem'}</button>
            </>}
          </div></div>}
          <ol className="seller-stop-list">{stops.map((stop) => {
            const pendingIndex = pending.indexOf(stop.routeVersionStopId);
            return <li key={stop.routeVersionStopId} className="seller-stop-card" data-status={stop.status}>
              <div className="seller-stop-number" aria-label={`Parada ${stop.executionOrder}`}>{String(stop.executionOrder).padStart(2, '0')}</div>
              <div className="seller-stop-info"><div className="seller-stop-meta"><span className={`seller-stop-status status-${stop.status}`}>{statusLabels[stop.status]}</span><span>Prioridade {stop.priority}</span></div><h3>{stop.client.name}</h3><p>{stop.client.address}</p>
                <span className="seller-planned-order">Ordem planejada {stop.plannedOrder}</span>
                <NavigationActions client={stop.client} offline={offline} busy={busy || needsReload} />
                {!draft && (stop.status === 'pending' || visitDrafts[stop.routeVersionStopId]) && <button
                  className="seller-button seller-visit-action"
                  disabled={busy || needsReload || visitBusyStop !== null || offlineCache === null || offlineCache === 'saving'}
                  onClick={() => void beginVisit(stop)}
                >{visitBusyStop === stop.routeVersionStopId ? 'Salvando no aparelho…'
                    : visitDrafts[stop.routeVersionStopId] ? 'Continuar visita' : 'Iniciar visita'}</button>}
              </div>
              {draft && stop.status === 'pending' && <div className="seller-move-controls">
                <button className="seller-button seller-secondary" aria-label={`Subir ${stop.client.name}`} disabled={busy || needsReload || pendingIndex === 0} onClick={() => setDraft(movePending(stops, stop.routeVersionStopId, -1))}>↑</button>
                <button className="seller-button seller-secondary" aria-label={`Descer ${stop.client.name}`} disabled={busy || needsReload || pendingIndex === pending.length - 1} onClick={() => setDraft(movePending(stops, stop.routeVersionStopId, 1))}>↓</button>
              </div>}
            </li>;
          })}</ol>
          <SavedVisits route={route} drafts={Object.values(visitDrafts)} />
          {!draft && <button className="seller-button seller-refresh" onClick={() => void load()} disabled={busy || offline}>↻ Atualizar rota</button>}
        </section>
      </div>}
      <footer className="seller-footer"><span>CIRNE ROTAS</span><p>Rota e início de visita disponíveis online e offline.</p></footer>
    </main>
  </div>;
}
