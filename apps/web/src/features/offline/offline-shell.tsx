'use client';

import { useEffect, useRef, useState } from 'react';
import type { LocalRouteBundle } from '@cirne/contracts';
import { OfflineFoundationService, type OfflineShellResult, type OfflineSnapshot } from '@/lib/offline/service';
import type { SaveDraftCommand } from '@/lib/offline/repository';

function StateLegend() {
  return (
    <section className="panel" aria-labelledby="state-title">
      <h2 id="state-title">Estados desta versão</h2>
      <ul className="state-list">
        <li><strong>Salvo no aparelho</strong> — o commit local terminou.</li>
        <li><strong>Pendente</strong> — aguarda a futura sincronização.</li>
        <li><strong>Erro recuperável</strong> — poderá ser tentado novamente.</li>
        <li><strong>Ação necessária</strong> — precisa de intervenção antes do envio.</li>
        <li><strong>Sincronizado</strong> — confirmação canônica persistida; o evento saiu da fila local.</li>
      </ul>
    </section>
  );
}

function ReadyRoute({
  snapshot,
  busy,
  saveError,
  onSave,
  onSync,
}: {
  snapshot: OfflineSnapshot;
  busy: boolean;
  saveError: string | null;
  onSave: (bundle: LocalRouteBundle) => void;
  onSync: () => void;
}) {
  const bundle = snapshot.routes.find((route): route is LocalRouteBundle => route.schemaVersion === 1);
  if (!bundle) {
    return <div className="status" data-kind="warning" role="status"><span aria-hidden>○</span><span>Nenhum pacote de rota foi salvo nesta partição.</span></div>;
  }
  const available = snapshot.workerReady;
  return (
    <>
      <div className="status" data-kind={available ? 'success' : 'warning'} role="status">
        <span aria-hidden>{available ? '✓' : '!'}</span>
        <span><strong>{available ? 'Disponível offline' : 'Pacote salvo; shell ainda não confirmado'}</strong><br />Rota sintética v{bundle.routeVersion}, sem cliente ou endereço real.</span>
      </div>
      <section className="panel" aria-labelledby="route-title">
        <h2 id="route-title">Rota de demonstração</h2>
        <ol className="route-list">
          {bundle.stops.map((stop) => <li key={stop.routeVersionStopId}>{stop.displayLabel}</li>)}
        </ol>
        <p><span className="badge">Salvo no aparelho</span></p>
        <button className="primary" disabled={busy || !available} onClick={() => onSave(bundle)}>
          {busy ? 'Salvando…' : snapshot.drafts.length ? 'Salvar nova edição local' : 'Iniciar rascunho local'}
        </button>
        <button disabled={busy || !available || snapshot.outbox.length === 0} onClick={onSync}>
          {busy ? 'Processando…' : 'Sincronizar agora'}
        </button>
        {saveError ? <p className="status" data-kind="error" role="alert">{saveError}</p> : null}
        {snapshot.drafts.length ? <p role="status"><strong>Rascunho {snapshot.drafts[0]?.persistenceState === 'synced' ? 'sincronizado' : 'salvo no aparelho'}.</strong></p> : null}
        <p><strong>{snapshot.outbox.length}</strong> evento(s) ainda na fila local.</p>
        <p className="muted">Persistência reforçada pelo navegador: {snapshot.storagePersisted ? 'concedida' : 'não garantida'}.</p>
      </section>
    </>
  );
}

export function OfflineShell() {
  const serviceRef = useRef<OfflineFoundationService | null>(null);
  const retryCommandRef = useRef<SaveDraftCommand | null>(null);
  const [result, setResult] = useState<OfflineShellResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const service = new OfflineFoundationService();
    serviceRef.current = service;
    let active = true;
    service.initialize()
      .then((next) => { if (active) setResult(next); })
      .catch(() => { if (active) setResult({ kind: 'blocked', reason: 'authentication_required', message: 'Não foi possível abrir o armazenamento local.' }); });
    return () => { active = false; service.close(); };
  }, []);

  async function provision() {
    if (!serviceRef.current) return;
    setBusy(true);
    setSaveError(null);
    try { setResult(await serviceRef.current.provisionSyntheticRoute()); }
    catch (error) { setSaveError(error instanceof Error ? error.message : 'Falha ao carregar o pacote sintético.'); }
    finally { setBusy(false); }
  }

  async function saveDraft(bundle: LocalRouteBundle) {
    const service = serviceRef.current;
    if (!service || result?.kind !== 'ready') return;
    setBusy(true);
    setSaveError(null);
    const command = retryCommandRef.current ?? service.createDraftCommand(bundle, result.drafts[0]?.offlineId);
    retryCommandRef.current = command;
    try {
      await service.saveDraft(command);
      retryCommandRef.current = null;
      setResult(await service.refresh(result.partition));
    } catch (error) {
      setSaveError(error instanceof Error && error.name === 'QuotaExceededError'
        ? 'Espaço insuficiente: nada foi confirmado como salvo.'
        : 'Não foi possível salvar. O comando pode ser tentado novamente sem duplicação.');
    } finally { setBusy(false); }
  }

  async function synchronize() {
    const service = serviceRef.current;
    if (!service || result?.kind !== 'ready') return;
    setBusy(true);
    setSaveError(null);
    try {
      const summary = await service.synchronize(result.partition);
      setResult(await service.refresh(result.partition));
      if (summary.authenticationRequired) setSaveError('Revalide sua identidade online antes de sincronizar.');
      else if (summary.actionRequired) setSaveError('Há evento que exige ação antes de um novo envio.');
      else if (summary.recoverable) setSaveError('A conexão falhou; o evento foi preservado para nova tentativa.');
    } catch {
      setSaveError('Não foi possível sincronizar. Os eventos locais foram preservados.');
    } finally { setBusy(false); }
  }

  return (
    <main className="offline-shell">
      <header><p className="eyebrow">Cirne Rotas · núcleo local</p><h1>Rota de campo</h1><p className="lede">Shell genérico. Identidade, token e conteúdo privado não fazem parte do HTML em cache.</p></header>
      {!result ? <div className="status" role="status">Preparando armazenamento local…</div> : null}
      {result?.kind === 'empty' ? (
        <section className="panel"><h2>Sem rota offline</h2><p>{result.message}</p>{result.demoAvailable ? <button className="primary" disabled={busy} onClick={provision}>{busy ? 'Carregando…' : 'Carregar rota sintética local'}</button> : null}{saveError ? <p className="status" data-kind="error" role="alert">{saveError}</p> : null}</section>
      ) : null}
      {result?.kind === 'blocked' ? <div className="status" data-kind="warning" role="alert"><span aria-hidden>!</span><span><strong>Acesso local bloqueado</strong><br />{result.message}</span></div> : null}
      {result?.kind === 'ready' ? <ReadyRoute snapshot={result} busy={busy} saveError={saveError} onSave={saveDraft} onSync={synchronize} /> : null}
      <StateLegend />
    </main>
  );
}
