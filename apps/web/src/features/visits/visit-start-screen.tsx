'use client';

import { useEffect, useRef, useState } from 'react';
import type { StockInput } from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';
import { OfflineFoundationService } from '@/lib/offline/service';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { initialVisitView, VisitStartController } from './visit-start-controller';
import { VisitStockStep } from './stock/visit-stock-step';

export function VisitStartScreen({ offlineId }: { offlineId: string }) {
  const controllerRef = useRef<VisitStartController | null>(null);
  const nextStepTitleRef = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState(initialVisitView);
  const [step, setStep] = useState<'start' | 'stock' | 'prices'>('start');
  const { draft, state, message: syncMessage } = view;

  useEffect(() => {
    if (state === 'ready' && step === 'prices') nextStepTitleRef.current?.focus();
  }, [state, step]);

  useEffect(() => {
    const readStep = () => {
      const requested = new URLSearchParams(window.location.search).get('step');
      setStep(requested === 'stock' || requested === 'prices' ? requested : 'start');
    };
    readStep();
    const service = new OfflineFoundationService();
    const controller = new VisitStartController(
      offlineId, service, setView, () => navigator.onLine,
    );
    controllerRef.current = controller;
    const resume = () => { void controller.resume(); };
    const foreground = () => { if (document.visibilityState === 'visible') resume(); };
    const stopObserving = observeLocalAccessRevocation(() => {
      service.blockLocalAccess();
      controller.blockAccess();
    });
    window.addEventListener('online', resume);
    window.addEventListener('popstate', readStep);
    document.addEventListener('visibilitychange', foreground);
    resume();
    return () => {
      window.removeEventListener('online', resume);
      window.removeEventListener('popstate', readStep);
      document.removeEventListener('visibilitychange', foreground);
      stopObserving();
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [offlineId]);

  const navigateStep = (next: 'start' | 'stock' | 'prices') => {
    const url = new URL(window.location.href);
    if (next === 'start') url.searchParams.delete('step');
    else url.searchParams.set('step', next);
    window.history.pushState({}, '', url);
    setStep(next);
  };

  useEffect(() => {
    if (state !== 'ready' || !draft || step !== 'prices' || draft.stock) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'stock');
    window.history.replaceState({}, '', url);
    setStep('stock');
  }, [draft, state, step]);

  const saveStock = async (values: StockInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveStock(values);
    navigateStep('prices');
  };

  const showStockStep = step === 'stock' || (step === 'prices' && !draft?.stock);

  return <div className="seller-app seller-route-page">
    <header className="seller-topbar"><div className="seller-topbar-inner"><Brand /></div></header>
    <main className="seller-route-main" id="main-content" aria-busy={state === 'loading'}>
      {state === 'loading' && <section className="seller-state" role="status">
        <span className="seller-loading" aria-hidden="true" />
        <h1>Abrindo a visita…</h1>
        <p>Validando o compromisso salvo neste aparelho.</p>
      </section>}
      {state === 'blocked' && <section className="seller-state">
        <h1>Acesso local bloqueado</h1>
        <p>Reconecte-se e entre novamente com o mesmo vendedor para continuar.</p>
        <a className="seller-button seller-primary" href="/login">Ir para o login</a>
      </section>}
      {state === 'missing' && <section className="seller-state">
        <h1>Visita não encontrada neste aparelho</h1>
        <p>Abra a rota salva e inicie ou continue a visita pela parada correspondente.</p>
        <a className="seller-button seller-primary" href="/route">Voltar para a rota</a>
      </section>}
      {state === 'ready' && draft && <div className="seller-visit-start">
        <p className="seller-kicker">VISITA EM ANDAMENTO</p>
        <h1>{draft.client?.name ?? 'Atendimento salvo'}<span className="seller-heading-dot">.</span></h1>
        {draft.client?.address && <p className="seller-muted">{draft.client.address}</p>}
        <section className="seller-progress" aria-labelledby="visit-state-title">
          <h2 id="visit-state-title">Início da visita</h2>
          <p><strong>{draft.persistenceState === 'synced' ? 'Sincronizada' : 'Salva no aparelho'}</strong></p>
          <p>Iniciada em {new Date(draft.deviceStartedAt ?? draft.updatedAt).toLocaleString('pt-BR')}.</p>
          {syncMessage && <p role="status">{syncMessage}</p>}
          {view.requiresLogin && <a className="seller-button seller-primary" href="/login">Entrar novamente</a>}
          {draft.persistenceState !== 'synced' && !view.requiresLogin && <button
            className="seller-button seller-secondary" disabled={view.busy}
            onClick={() => void controllerRef.current?.resume()}
          >Tentar sincronizar novamente</button>}
        </section>
        {draft.stock && <p className="seller-step-progress" role="status">1 de 4 etapas preenchidas</p>}
        {step === 'start' && <>
          <button className="seller-button seller-primary seller-stock-entry" onClick={() => navigateStep('stock')}>
            {draft.stock ? 'Revisar estoque' : 'Preencher estoque'}
          </button>
        </>}
        {showStockStep && <VisitStockStep
          key={draft.stock?.eventId ?? 'new-stock'}
          draft={draft}
          onSave={saveStock}
        />}
        {step === 'prices' && draft.stock && <section className="seller-next-step" aria-labelledby="next-step-title">
          <p className="seller-kicker">ESTOQUE</p>
          <h2 id="next-step-title" ref={nextStepTitleRef} tabIndex={-1}>Salvo no aparelho</h2>
          <p>Heliar: <strong>{draft.stock?.heliarQuantity ?? 0}</strong> · Moura: <strong>{draft.stock?.mouraQuantity ?? 0}</strong></p>
          <p className="seller-notice">A etapa de Preços será liberada na próxima story.</p>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('stock')}>Editar estoque</button>
        </section>}
        <a className="seller-button seller-secondary" href="/route">Retornar à rota</a>
      </div>}
    </main>
  </div>;
}
