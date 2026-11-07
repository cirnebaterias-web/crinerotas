'use client';

import { useEffect, useRef, useState } from 'react';
import type { CommercialActionsInput, CompetitorPricesInput, StockInput } from '@cirne/contracts';
import { Brand } from '@/features/auth/brand';
import { OfflineFoundationService } from '@/lib/offline/service';
import { observeLocalAccessRevocation } from '@/lib/offline/access-revocation';
import { initialVisitView, VisitStartController } from './visit-start-controller';
import { VisitCompetitorPricesStep } from './prices/visit-competitor-prices-step';
import { VisitStockStep } from './stock/visit-stock-step';
import { VisitCompetitorStockStep } from './stock/visit-competitor-stock-step';
import { VisitStockPhotosStep } from './stock/visit-stock-photos-step';
import type { CompressedStockPhoto } from './stock/stock-photo-compression';
import { VisitEvidenceCapture, type VisitEvidenceCaptureValue } from './visit-evidence-capture';
import { VisitCommercialActionsStep } from './actions/visit-commercial-actions-step';
import { VisitScrapStep } from './scrap/visit-scrap-step';

type VisitScreenStep = 'start' | 'stock' | 'competitor-stock' | 'stock-photos' | 'prices' | 'actions' | 'scrap' | 'review' | 'complete';

export function VisitStartScreen({ offlineId }: { offlineId: string }) {
  const controllerRef = useRef<VisitStartController | null>(null);
  const nextStepTitleRef = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState(initialVisitView);
  const [step, setStep] = useState<VisitScreenStep>('start');
  const [showCheckout, setShowCheckout] = useState(false);
  const [showStockReopen, setShowStockReopen] = useState(false);
  const [showStockExit, setShowStockExit] = useState(false);
  const [competitorDirty, setCompetitorDirty] = useState(false);
  const { draft, state, message: syncMessage } = view;
  const stockPhotos = view.attachments.filter((item) => item.purpose === 'stock_evidence');
  const stockComplete = Boolean(draft?.stock?.collectionCompletedAt &&
    stockPhotos.length >= 3 && stockPhotos.length <= 5);
  const checkinEvidence = view.evidence.find((item) => item.kind === 'checkin' && item.latitude && item.longitude);

  useEffect(() => {
    if (state === 'ready' && step === 'review') nextStepTitleRef.current?.focus();
  }, [state, step]);

  useEffect(() => {
    if (state !== 'ready' || draft?.localStatus !== 'completed' ||
      !['review', 'actions', 'scrap'].includes(step)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'complete');
    window.history.replaceState({}, '', url);
    setShowCheckout(false);
    setStep('complete');
  }, [draft, state, step]);

  useEffect(() => {
    const readStep = () => {
      const requested = new URLSearchParams(window.location.search).get('step');
      setStep(requested === 'stock' || requested === 'competitor-stock' || requested === 'stock-photos' ||
        requested === 'prices' || requested === 'actions' || requested === 'scrap' || requested === 'review' || requested === 'complete'
        ? requested
        : 'start');
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

  const navigateStep = (next: VisitScreenStep, brand?: string) => {
    const url = new URL(window.location.href);
    if (next === 'start') url.searchParams.delete('step');
    else url.searchParams.set('step', next);
    if (next !== 'stock') url.searchParams.delete('brand');
    else if (brand) url.searchParams.set('brand', brand);
    window.history.pushState({}, '', url);
    setStep(next);
  };

  useEffect(() => {
    if (state !== 'ready' || !draft || stockComplete ||
      !['prices', 'actions', 'scrap', 'review'].includes(step)) return;
    const target: VisitScreenStep = !draft.stock?.completedOwnBrands || draft.stock.completedOwnBrands.length < 4
      ? 'stock' : draft.stock.competitorLines === undefined ? 'competitor-stock' : 'stock-photos';
    const url = new URL(window.location.href);
    url.searchParams.set('step', target);
    window.history.replaceState({}, '', url);
    setStep(target);
  }, [draft, state, step, stockComplete]);

  useEffect(() => {
    if (state !== 'ready' || !draft || !['competitor-stock', 'prices', 'actions', 'scrap', 'review'].includes(step)
      || (draft.stock && (!draft.stock.completedOwnBrands || draft.stock.completedOwnBrands.length === 4))) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'stock');
    window.history.replaceState({}, '', url);
    setStep('stock');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft?.stock || !['prices', 'actions', 'scrap', 'review'].includes(step)
      || !draft.stock.completedOwnBrands || draft.stock.completedOwnBrands.length < 4
      || draft.stock.competitorLines !== undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'competitor-stock');
    url.searchParams.delete('brand');
    window.history.replaceState({}, '', url);
    setStep('competitor-stock');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft || step !== 'actions' || !draft.stock || draft.prices) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'prices');
    window.history.replaceState({}, '', url);
    setStep('prices');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft || !['scrap', 'review'].includes(step) || draft.commercialActions) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'actions');
    window.history.replaceState({}, '', url);
    setStep('actions');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft?.commercialActions || step !== 'review' || draft.scrap) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'scrap');
    window.history.replaceState({}, '', url);
    setStep('scrap');
  }, [draft, state, step]);

  const saveStock = async (values: StockInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveStock(values);
  };

  const saveCompetitorStock = async (values: StockInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveStock(values);
    setCompetitorDirty(false);
    navigateStep('stock-photos');
  };

  const completeStockCollection = async () => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.completeStockCollection();
    navigateStep('start');
  };

  const reopenStockCollection = async () => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.reopenStockCollection();
    setShowStockReopen(false);
    navigateStep('stock');
  };

  const openStockCollection = () => {
    if (stockComplete) setShowStockReopen(true);
    else navigateStep('stock');
  };

  const requestStockExit = () => {
    if (['stock', 'competitor-stock', 'stock-photos'].includes(step)) setShowStockExit(true);
    else navigateStep('start');
  };

  const savePrices = async (values: CompetitorPricesInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.savePrices(values);
    navigateStep('actions');
  };

  const saveCommercialActions = async (values: CommercialActionsInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveCommercialActions(values);
    navigateStep('scrap');
  };

  const addCommercialActionEvidence = async (targetOfflineId: string, photo: CompressedStockPhoto, fileName: string) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    return controller.addCommercialActionEvidence(targetOfflineId, photo, fileName);
  };

  const addStockPhoto = async (photo: CompressedStockPhoto, fileName: string) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.addStockPhoto(photo, fileName);
  };

  const removeStockPhoto = async (offlineId: string) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.removeStockPhoto(offlineId);
  };

  const completeVisit = async (evidence: VisitEvidenceCaptureValue) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para encerramento.');
    await controller.completeVisit(evidence);
    setShowCheckout(false);
    navigateStep('complete');
  };

  const showStockStep = step === 'stock';

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
        {step === 'start' && <section className="seller-progress" aria-labelledby="visit-state-title">
          <h2 id="visit-state-title">Início da visita</h2>
          <p><strong>{draft.persistenceState === 'synced' ? 'Sincronizada' : 'Salva no aparelho'}</strong></p>
          <p>Iniciada em {new Date(draft.deviceStartedAt ?? draft.updatedAt).toLocaleString('pt-BR')}.</p>
          {syncMessage && <p role="status">{syncMessage}</p>}
          {view.requiresLogin && <a className="seller-button seller-primary" href="/login">Entrar novamente</a>}
          {draft.persistenceState !== 'synced' && !view.requiresLogin && <button
            className="seller-button seller-secondary" disabled={view.busy}
            onClick={() => void controllerRef.current?.resume()}
          >Tentar sincronizar novamente</button>}
        </section>}
        {step !== 'start' && syncMessage && <p className="seller-muted" role="status">{syncMessage}</p>}
        {step === 'start' && draft.localStatus !== 'completed' && <section className="seller-task-list" aria-labelledby="visit-tasks-title">
          <p className="seller-kicker">TAREFAS DA VISITA</p>
          <h2 id="visit-tasks-title">O que você vai coletar?</h2>
          <button className="seller-task-card" onClick={openStockCollection}
            aria-label={`Coleta de estoque, ${stockComplete ? 'concluída. Abrir detalhes' : 'pendente. Abrir coleta'}`}>
            <span><strong>Coleta de estoque</strong><small>Produtos próprios, concorrência e fotos</small></span>
            <span>{stockComplete ? 'Concluído' : draft.stock ? 'Continuar coleta' : 'Iniciar'}</span>
          </button>
          <button className="seller-task-card" disabled={!stockComplete}
            onClick={() => navigateStep('prices')}>
            <span><strong>Preços da concorrência</strong><small>Cotações e indisponibilidade</small></span>
            <span>{draft.prices ? 'Editar' : stockComplete ? 'Iniciar' : 'Após concluir estoque'}</span>
          </button>
          <button className="seller-task-card" disabled={!draft.prices} onClick={() => navigateStep('actions')}>
            <span><strong>Ações comerciais</strong><small>Heliar e concorrência</small></span>
            <span>{draft.commercialActions ? 'Editar' : draft.prices ? 'Iniciar' : 'Após preços'}</span>
          </button>
          <button className="seller-task-card" disabled={!draft.commercialActions} onClick={() => navigateStep('scrap')}>
            <span><strong>Sucata</strong><small>Coleta realizada, agendamento ou sem sucata</small></span>
            <span>{draft.scrap ? 'Ver registro' : draft.commercialActions ? 'Iniciar' : 'Após ações comerciais'}</span>
          </button>
        </section>}
        {showStockStep && <><p className="seller-kicker" role="status">ESTOQUE · ETAPA 1 DE 3 · PRODUTOS PRÓPRIOS</p><VisitStockStep
          key={draft.offlineId}
          draft={draft}
          onSave={saveStock}
          onContinue={() => navigateStep('competitor-stock')}
        /></>}
        {step === 'competitor-stock' && draft.stock && <>
          <p className="seller-kicker" role="status">ESTOQUE · ETAPA 2 DE 3 · CONCORRÊNCIA</p>
          <button className="seller-button seller-secondary" type="button"
            onClick={() => navigateStep('stock', 'ACDelco')}>Voltar ao estoque próprio</button>
          <VisitCompetitorStockStep
            key={draft.offlineId}
            draft={draft}
            onSave={saveCompetitorStock}
            onDirtyChange={setCompetitorDirty}
          />
        </>}
        {step === 'stock-photos' && draft.stock && <VisitStockPhotosStep
          attachments={stockPhotos}
          onAdd={addStockPhoto}
          onRemove={removeStockPhoto}
          onDone={() => void completeStockCollection()}
        />}
        {step === 'prices' && draft.stock && <VisitCompetitorPricesStep
          key={draft.prices?.eventId ?? 'new-prices'}
          draft={draft}
          parameters={view.priceParameters ?? null}
          onSave={savePrices}
        />}
        {step !== 'start' && <button className="seller-button seller-secondary" type="button"
          onClick={requestStockExit}>{['stock', 'competitor-stock', 'stock-photos'].includes(step)
            ? 'Sair da coleta de estoque' : 'Voltar às tarefas'}</button>}
        {step === 'actions' && draft.prices && <VisitCommercialActionsStep
          draft={draft} actions={view.commercialActions} parameters={view.priceParameters ?? null}
          attachments={view.attachments} onAddEvidence={addCommercialActionEvidence} onSave={saveCommercialActions}
        />}
        {step === 'scrap' && draft.commercialActions && <VisitScrapStep draft={draft} attachments={view.attachments} points={view.scrapPoints}
          onSave={async (values) => { const controller = controllerRef.current; if (!controller) throw new Error('A visita ainda não está pronta.'); await controller.saveScrap(values); navigateStep('review'); }}
          onAddEvidence={async (collectionId, photo, name) => { const controller = controllerRef.current; if (!controller) throw new Error('A visita ainda não está pronta.'); return controller.addScrapEvidence(collectionId, photo, name); }} />}
        {step === 'review' && draft.commercialActions && draft.scrap && <section className="seller-next-step" aria-labelledby="next-step-title">
          <p className="seller-kicker">AÇÕES COMERCIAIS</p>
          <h2 id="next-step-title" ref={nextStepTitleRef} tabIndex={-1}>
            {draft.commercialActions.persistenceState === 'synced' ? 'Sincronizadas' : 'Salvas no aparelho'}
          </h2>
          <p>{draft.commercialActions.ownAcknowledgements.length} ação(ões) Heliar confirmada(s) e {
            draft.commercialActions.competitor.availability === 'identified'
              ? `${draft.commercialActions.competitor.actions.length} ação(ões) concorrente(s) registrada(s).`
              : 'nenhuma ação concorrente identificada.'}</p>
          <p className="seller-notice">Revise as coletas e encerre a visita ainda na fachada da loja.</p>
          <p>Sucata: {draft.scrap.availability === 'collected' ? `${draft.scrap.collection?.actualWeightKg} kg coletados · termo ${draft.scrap.collection?.receiptNumber}` : draft.scrap.availability === 'scheduled' ? `${draft.scrap.schedule?.estimatedWeightKg} kg previstos · ${draft.scrap.schedule?.desiredDate}` : 'Sem sucata'} · {draft.scrap.persistenceState === 'synced' ? 'Confirmada no servidor' : 'Salva no aparelho'}</p>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('scrap')}>Ver registro de sucata</button>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('actions')}>Editar ações</button>
          {draft.localStatus !== 'completed' && <button className="seller-button seller-primary"
            onClick={() => setShowCheckout(true)}>Encerrar visita</button>}
        </section>}
        {step === 'complete' && <section className="seller-next-step" aria-labelledby="visit-complete-title">
          <p className="seller-kicker">VISITA ENCERRADA</p>
          <h2 id="visit-complete-title">Checkout salvo no aparelho</h2>
          <p>Foto da fachada, posição e horário foram registrados. A sincronização ocorrerá quando a publicação privada estiver habilitada.</p>
        </section>}
        {showCheckout && draft.localStatus !== 'completed' && draft.client && <div className="seller-evidence-overlay">
          <VisitEvidenceCapture kind="checkout" client={draft.client} busy={view.busy}
            referenceLocation={checkinEvidence?.latitude && checkinEvidence.longitude
              ? { latitude: checkinEvidence.latitude, longitude: checkinEvidence.longitude } : undefined}
            onCancel={() => setShowCheckout(false)} onConfirm={completeVisit} />
        </div>}
        {showStockReopen && <div className="seller-evidence-overlay" role="dialog" aria-modal="true"
          aria-labelledby="stock-reopen-title" aria-describedby="stock-reopen-description">
          <section className="seller-stock-card">
            <h2 id="stock-reopen-title">Reabrir coleta de estoque?</h2>
            <p id="stock-reopen-description">A coleta já foi concluída. Ao reabrir, você poderá alterar quantidades, concorrentes e fotos; será necessário concluir novamente.</p>
            <button className="seller-button seller-secondary" autoFocus type="button"
              onClick={() => setShowStockReopen(false)}>Cancelar</button>{' '}
            <button className="seller-button seller-primary" type="button"
              onClick={() => void reopenStockCollection()}>Reabrir e editar</button>
          </section>
        </div>}
        {showStockExit && <div className="seller-evidence-overlay" role="dialog" aria-modal="true"
          aria-labelledby="stock-exit-title" aria-describedby="stock-exit-description">
          <section className="seller-stock-card">
            <h2 id="stock-exit-title">{competitorDirty ? 'Sair sem salvar?' : 'Sair da coleta de estoque?'}</h2>
            <p id="stock-exit-description">{competitorDirty
              ? 'As alterações no estoque da concorrência serão perdidas.'
              : 'A coleta ainda não foi concluída. Você poderá continuar depois.'}</p>
            <button className="seller-button seller-primary" autoFocus type="button"
              onClick={() => setShowStockExit(false)}>Continuar preenchendo</button>{' '}
            <button className="seller-button seller-secondary" type="button" onClick={() => {
              setCompetitorDirty(false); setShowStockExit(false); navigateStep('start');
            }}>Sair {competitorDirty ? 'sem salvar' : 'agora'}</button>
          </section>
        </div>}
        <a className="seller-button seller-secondary" href="/route">Retornar à rota</a>
      </div>}
    </main>
  </div>;
}
