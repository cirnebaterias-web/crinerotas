'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CanonicalRoute, MeResponse, RouteTodayResponse } from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';
import { isSessionFailure, sellerClient, SellerHttpError } from '@/lib/seller-client';
import { formatServiceDate, movePending, orderedStops, pendingIds, routeProgress } from './route-model';

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
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const clearPrivate = useCallback(() => { setIdentity(null); setToday(null); setDraft(null); }, []);
  const load = useCallback(async () => {
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
    } catch (error) {
      if (current !== generation.current) return;
      if (isSessionFailure(error)) setLoginRequired(true);
      else setMessage('Não foi possível carregar sua rota. Confira a conexão e tente novamente.');
    } finally { if (current === generation.current) setBusy(false); }
  }, [clearPrivate]);

  useEffect(() => {
    void load();
    const connectivity = () => setOffline(!navigator.onLine);
    connectivity();
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void load(); };
    const channel = new BroadcastChannel('cirne-session');
    channel.onmessage = () => { void load(); };
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    window.addEventListener('pageshow', restored);
    return () => {
      ++generation.current; controller.current?.abort(); channel.close();
      window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity);
      window.removeEventListener('pageshow', restored);
    };
  }, [load]);

  async function logout() {
    ++generation.current; controller.current?.abort(); clearPrivate(); setBusy(true); setMessage('');
    try { await sellerClient.logout(); window.location.replace('/login'); }
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
      {offline && <p className="seller-notice" role="status">Sem conexão. É necessário estar online para carregar e salvar. Alterações nesta tela ainda não estão salvas.</p>}
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
          <p className="seller-version">Versão da execução {route.executionVersion} · Consulta online<br />O uso offline desta rota será habilitado em uma próxima etapa.</p>
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
                <span className="seller-planned-order">Ordem planejada {stop.plannedOrder}</span></div>
              {draft && stop.status === 'pending' && <div className="seller-move-controls">
                <button className="seller-button seller-secondary" aria-label={`Subir ${stop.client.name}`} disabled={busy || needsReload || pendingIndex === 0} onClick={() => setDraft(movePending(stops, stop.routeVersionStopId, -1))}>↑</button>
                <button className="seller-button seller-secondary" aria-label={`Descer ${stop.client.name}`} disabled={busy || needsReload || pendingIndex === pending.length - 1} onClick={() => setDraft(movePending(stops, stop.routeVersionStopId, 1))}>↓</button>
              </div>}
            </li>;
          })}</ol>
          {!draft && <button className="seller-button seller-refresh" onClick={() => void load()} disabled={busy || offline}>↻ Atualizar rota</button>}
        </section>
      </div>}
      <footer className="seller-footer"><span>CIRNE ROTAS</span><p>Primeira experiência do MVP · Visitas e navegação ainda não disponíveis.</p></footer>
    </main>
  </div>;
}
