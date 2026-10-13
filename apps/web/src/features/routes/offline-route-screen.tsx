'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AnyCanonicalLocalRouteBundle, CanonicalRoute } from '@cirne/contracts';
import { restoreCanonicalRoute } from '@cirne/domain';
import { Brand } from '@/features/auth/brand';
import { SavedVisits } from '@/features/visits/saved-visits';
import { VisitEvidenceCapture, type VisitEvidenceCaptureValue } from '@/features/visits/visit-evidence-capture';
import { OfflineFoundationService, type OfflineShellResult } from '@/lib/offline/service';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { formatServiceDate, orderedStops, pendingIds, routeProgress } from './route-model';
import { NavigationActions } from './navigation-actions';

const statusLabels = {
  pending: 'Pendente',
  in_visit: 'Em visita',
  completed: 'Visitado',
  not_visited: 'Não visitado',
};

const blockedResult: OfflineShellResult = {
  kind: 'blocked', reason: 'authentication_required',
  message: 'O acesso local foi bloqueado. Conecte-se e entre novamente para liberar esta rota.',
};

function newestCanonicalRoute(result: OfflineShellResult | null) {
  if (result?.kind !== 'ready') return null;
  return result.routes
    .filter((bundle): bundle is AnyCanonicalLocalRouteBundle =>
      bundle.schemaVersion === 2 || bundle.schemaVersion === 3)
    .sort((left, right) => Date.parse(right.cachedAt) - Date.parse(left.cachedAt))[0] ?? null;
}

export function OfflineRouteScreen() {
  const serviceRef = useRef<OfflineFoundationService | null>(null);
  const accessBlocked = useRef(false);
  const [result, setResult] = useState<OfflineShellResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [revocationError, setRevocationError] = useState<string | null>(null);
  const [checkinStop, setCheckinStop] = useState<CanonicalRoute['stops'][number] | null>(null);
  const bundle = useMemo(() => newestCanonicalRoute(result), [result]);
  const route = useMemo(() => bundle ? restoreCanonicalRoute(bundle) : null, [bundle]);
  const stops = orderedStops(route?.stops ?? []);
  const pending = pendingIds(stops);
  const progress = routeProgress(stops);
  const visitDrafts = useMemo(() => result?.kind === 'ready'
    ? new Map(result.drafts.map((draft) => [draft.routeVersionStopId, draft]))
    : new Map(), [result]);

  useEffect(() => {
    const service = new OfflineFoundationService();
    serviceRef.current = service;
    accessBlocked.current = false;
    let active = true;
    const stopObserving = observeLocalAccessRevocation(() => {
      accessBlocked.current = true;
      service.blockLocalAccess();
      setResult(blockedResult); setBusy(false); setRevocationError(null);
    });
    service.initialize()
      .then((next) => { if (active && !accessBlocked.current) setResult(next); })
      .catch(() => {
        if (active && !accessBlocked.current) setResult({
          kind: 'blocked',
          reason: 'authentication_required',
          message: 'Não foi possível abrir o armazenamento local deste aparelho.',
        });
      });
    return () => {
      active = false;
      stopObserving();
      service.close();
      if (serviceRef.current === service) serviceRef.current = null;
    };
  }, []);

  async function revokeLocalAccess() {
    if (!serviceRef.current || !bundle) return;
    accessBlocked.current = true;
    serviceRef.current.blockLocalAccess();
    setResult(blockedResult);
    setBusy(true);
    setRevocationError(null);
    try {
      await serviceRef.current.revokeLocalAccess(bundle.userId);
    } catch {
      setRevocationError('Os dados foram ocultados, mas o bloqueio no armazenamento não pôde ser confirmado. Reconecte-se e saia da conta para concluir.');
    } finally {
      setBusy(false);
    }
  }

  async function beginVisit(stop: CanonicalRoute['stops'][number]) {
    if (accessBlocked.current || !serviceRef.current || !bundle || busy) return;
    const existing = visitDrafts.get(stop.routeVersionStopId);
    if (existing) {
      try {
        const evidence = await serviceRef.current.listVisitEvidence(bundle.userId, existing.offlineId);
        if (evidence.some((item) => item.kind === 'checkin')) {
          window.location.assign(`/visit/${existing.offlineId}?step=${existing.currentStep}`);
        } else {
          setCheckinStop(stop);
          setRevocationError('A visita está salva, mas o check-in precisa ser concluído.');
        }
      } catch {
        setRevocationError('Não foi possível verificar a evidência salva neste aparelho. Tente novamente.');
      }
      return;
    }
    setCheckinStop(stop);
  }

  async function confirmCheckin(stop: CanonicalRoute['stops'][number], evidence: VisitEvidenceCaptureValue) {
    if (accessBlocked.current || !serviceRef.current || !bundle || busy) return;
    const service = serviceRef.current;
    setBusy(true);
    setRevocationError(null);
    try {
      let draft = visitDrafts.get(stop.routeVersionStopId);
      if (!draft) {
        const started = await service.startVisit({
          userId: bundle.userId,
          routeVersionStopId: stop.routeVersionStopId,
          ...(evidence.location ? { location: evidence.location } : {}),
        });
        draft = started.draft;
      }
      await service.saveVisitEvidence({
        userId: bundle.userId,
        visitOfflineId: draft.offlineId,
        kind: 'checkin',
        ...evidence,
      });
      if (accessBlocked.current || serviceRef.current !== service) return;
      setCheckinStop(null);
      window.location.assign(`/visit/${draft.offlineId}?step=${draft.currentStep}`);
    } catch {
      if (accessBlocked.current || serviceRef.current !== service) return;
      setRevocationError('Não foi possível salvar o início da visita. A parada continua inalterada.');
      setBusy(false);
    }
  }

  return <div className="seller-app seller-route-page">
    <header className="seller-topbar"><div className="seller-topbar-inner"><Brand />
      <div className="seller-account">{route && <><span className="seller-avatar" aria-hidden="true">{route.seller.displayName.slice(0, 1)}</span><span className="seller-account-name">{route.seller.displayName}<small>Vendedor</small></span></>}
        <button className="seller-button seller-quiet" onClick={() => void revokeLocalAccess()} disabled={busy || !route}>Bloquear acesso local</button>
      </div></div></header>
    <main className="seller-route-main" id="main-content" aria-busy={!result || busy}>
      <div className="seller-title-row"><div><p className="seller-kicker">SEU DIA EM CAMPO</p><h1>Minha rota de hoje<span className="seller-heading-dot">.</span></h1>
        <p className="seller-muted">{route ? formatServiceDate(route.serviceDate) : 'Consultando a cópia salva neste aparelho.'}</p>
        {route && <p className="seller-owner">{route.seller.displayName}</p>}</div>
        <span className="seller-connection is-offline"><span aria-hidden="true">●</span> Sem conexão</span>
      </div>
      {route && <p className="seller-notice" role="status">Você está vendo a última rota salva neste aparelho. Atualizações, reordenação e Google Maps precisam de conexão.</p>}
      {revocationError && <p className="seller-notice" role="alert">{revocationError}</p>}
      {!result && <div className="seller-state" role="status"><span className="seller-loading" aria-hidden="true" /><h2>Abrindo sua rota salva…</h2><p>Validando o acesso local sem consultar dados privados na rede.</p></div>}
      {result?.kind === 'blocked' && <section className="seller-state"><h2>Acesso local bloqueado</h2><p>{result.message}</p><a className="seller-button seller-primary" href="/login">Entrar quando houver conexão</a></section>}
      {result?.kind === 'empty' && <section className="seller-state"><h2>Sem rota offline</h2><p>{result.message}</p><a className="seller-button seller-primary" href="/route">Tentar carregar minha rota</a></section>}
      {result?.kind === 'ready' && !route && <section className="seller-state"><h2>Rota real ainda não salva</h2><p>Conecte-se e abra sua rota publicada uma vez. A demonstração local nunca substitui seus dados.</p><a className="seller-button seller-primary" href="/route">Tentar carregar minha rota</a></section>}
      {route && bundle && <div className="seller-route-layout">
        <aside className="seller-overview" aria-label="Resumo do dia">
          <section className="seller-progress"><p className="seller-kicker">PROGRESSO DO DIA</p><div className="seller-progress-inner">
            <div><strong>{progress.completed} <span>de {progress.total}</span></strong><p>clientes visitados</p></div>
            <div className="seller-ring" style={{ '--progress': `${progress.percent}%` } as CSSProperties} aria-label={`${progress.percent}% das visitas concluídas`}><span>{progress.percent}<small>%</small></span></div>
          </div><div className="seller-progress-bottom"><span>{pending.length} parada{pending.length !== 1 ? 's' : ''} pendente{pending.length !== 1 ? 's' : ''}</span><span>Salva no aparelho <span aria-hidden="true">✓</span></span></div></section>
          <div className="seller-route-tip"><span className="seller-tip-icon" aria-hidden="true">⌁</span><div><h2>Consulta offline</h2><p>Você pode consultar clientes e copiar endereços. Reconecte-se para receber mudanças ou reorganizar as paradas.</p></div></div>
          <p className="seller-version">Versão da execução {route.executionVersion} · Cópia offline<br />Atualizada em {new Date(bundle.cachedAt).toLocaleString('pt-BR')}.</p>
        </aside>
        <section className="seller-stops" aria-labelledby="offline-stops-title">
          <div className="seller-section-heading"><div><h2 id="offline-stops-title">Paradas do dia <span>{stops.length}</span></h2><p>Última ordem confirmada pelo servidor.</p></div></div>
          <ol className="seller-stop-list">{stops.map((stop) => <li key={stop.routeVersionStopId} className="seller-stop-card" data-status={stop.status}>
            <div className="seller-stop-number" aria-label={`Parada ${stop.executionOrder}`}>{String(stop.executionOrder).padStart(2, '0')}</div>
            <div className="seller-stop-info"><div className="seller-stop-meta"><span className={`seller-stop-status status-${stop.status}`}>{statusLabels[stop.status]}</span><span>Prioridade {stop.priority}</span></div><h3>{stop.client.name}</h3><p>{stop.client.address}</p>
              <span className="seller-planned-order">Ordem planejada {stop.plannedOrder}</span>
              <NavigationActions client={stop.client} offline busy={busy} />
              {(stop.status === 'pending' || visitDrafts.has(stop.routeVersionStopId)) && <button
                className="seller-button seller-visit-action"
                disabled={busy}
                onClick={() => void beginVisit(stop)}
              >{visitDrafts.has(stop.routeVersionStopId) ? 'Continuar visita' : 'Iniciar visita'}</button>}
            </div>
          </li>)}</ol>
          <SavedVisits route={route} drafts={result?.kind === 'ready' ? result.drafts : []} />
          <a className="seller-button seller-refresh" href="/route">↻ Tentar atualizar com conexão</a>
        </section>
      </div>}
      {checkinStop && <div className="seller-evidence-overlay">
        <VisitEvidenceCapture kind="checkin" client={checkinStop.client} busy={busy}
          onCancel={() => setCheckinStop(null)} onConfirm={(evidence) => confirmCheckin(checkinStop, evidence)} />
      </div>}
      <footer className="seller-footer"><span>CIRNE ROTAS</span><p>Cópia local protegida pela última validação deste vendedor neste aparelho.</p></footer>
    </main>
  </div>;
}
