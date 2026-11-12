'use client';

import { useEffect, useRef, useState } from 'react';
import type { CommercialActionsInput, CompetitorPricesInput, StockInput, VisitSalesInput } from '@cirne/contracts';
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
import { VisitSalesStep } from './sales/visit-sales-step';

type VisitScreenStep = 'start' | 'stock' | 'competitor-stock' | 'stock-photos' | 'prices' | 'actions' | 'sales' | 'scrap' | 'review' | 'complete';

const visitStepLabels: Record<VisitScreenStep, string> = {
  start: 'Tarefas', stock: 'Estoque 1/3', 'competitor-stock': 'Estoque 2/3',
  'stock-photos': 'Estoque 3/3', prices: 'Preços', actions: 'Ações', sales: 'Informe de venda', scrap: 'Sucata',
  review: 'Revisão', complete: 'Concluída',
};

export function VisitStartScreen({ offlineId }: { offlineId: string }) {
  const controllerRef = useRef<VisitStartController | null>(null);
  const nextStepTitleRef = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState(initialVisitView);
  const [step, setStep] = useState<VisitScreenStep>('start');
  const [showCheckout, setShowCheckout] = useState(false);
  const [showStockReopen, setShowStockReopen] = useState(false);
  const [showStockExit, setShowStockExit] = useState(false);
  const [showRouteExit, setShowRouteExit] = useState(false);
  const [competitorDirty, setCompetitorDirty] = useState(false);
  const [pricesDirty, setPricesDirty] = useState(false);
  const [salesDirty, setSalesDirty] = useState(false);
  const navigationStateRef = useRef({ step, competitorDirty, pricesDirty, salesDirty });
  const { draft, state, message: syncMessage } = view;
  const recoveringSales = Boolean(draft?.localStatus === 'completed' &&
    draft.salesCompletionRecovery && !draft.serverCompletedAt);
  const stockPhotos = view.attachments.filter((item) => item.purpose === 'stock_evidence');
  const stockComplete = Boolean(draft?.stock?.collectionCompletedAt &&
    stockPhotos.length >= 3 && stockPhotos.length <= 5);
  const checkinEvidence = view.evidence.find((item) => item.kind === 'checkin' && item.latitude && item.longitude);

  useEffect(() => {
    navigationStateRef.current = { step, competitorDirty, pricesDirty, salesDirty };
  }, [step, competitorDirty, pricesDirty, salesDirty]);

  useEffect(() => {
    if (state === 'ready' && step === 'review') nextStepTitleRef.current?.focus();
  }, [state, step]);

  useEffect(() => {
    if (state !== 'ready' || draft?.localStatus !== 'completed') return;
    const target = recoveringSales && !draft.sales ? 'sales' : 'complete';
    if (step === target || (recoveringSales && step === 'sales')) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', target);
    window.history.replaceState({}, '', url);
    setShowCheckout(false);
    setStep(target);
  }, [draft, state, step, recoveringSales]);

  useEffect(() => {
    const readStep = () => {
      const requested = new URLSearchParams(window.location.search).get('step');
      const next = requested === 'stock' || requested === 'competitor-stock' || requested === 'stock-photos' ||
        requested === 'prices' || requested === 'actions' || requested === 'sales' || requested === 'scrap' || requested === 'review' || requested === 'complete'
        ? requested
        : 'start';
      const current = navigationStateRef.current;
      const hasUnsavedChanges = current.competitorDirty || current.pricesDirty || current.salesDirty;
      if (next !== current.step && hasUnsavedChanges) {
        const restored = new URL(window.location.href);
        if (current.step === 'start') restored.searchParams.delete('step');
        else restored.searchParams.set('step', current.step);
        window.history.pushState({}, '', restored);
        setShowStockExit(true);
        return;
      }
      setStep(next);
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
    if (next !== 'prices') {
      url.searchParams.delete('priceView');
      url.searchParams.delete('priceBrand');
    }
    window.history.pushState({}, '', url);
    setStep(next);
  };

  useEffect(() => {
    if (state !== 'ready' || !draft || draft.localStatus === 'completed' || stockComplete ||
      !['prices', 'actions', 'sales', 'scrap', 'review'].includes(step)) return;
    const target: VisitScreenStep = !draft.stock?.completedOwnBrands || draft.stock.completedOwnBrands.length < 4
      ? 'stock' : draft.stock.competitorLines === undefined ? 'competitor-stock' : 'stock-photos';
    const url = new URL(window.location.href);
    url.searchParams.set('step', target);
    window.history.replaceState({}, '', url);
    setStep(target);
  }, [draft, state, step, stockComplete]);

  useEffect(() => {
    if (state !== 'ready' || !draft || draft.localStatus === 'completed' || !['competitor-stock', 'prices', 'actions', 'sales', 'scrap', 'review'].includes(step)
      || (draft.stock && (!draft.stock.completedOwnBrands || draft.stock.completedOwnBrands.length === 4))) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'stock');
    window.history.replaceState({}, '', url);
    setStep('stock');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft?.stock || draft.localStatus === 'completed' || !['prices', 'actions', 'sales', 'scrap', 'review'].includes(step)
      || !draft.stock.completedOwnBrands || draft.stock.completedOwnBrands.length < 4
      || draft.stock.competitorLines !== undefined) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'competitor-stock');
    url.searchParams.delete('brand');
    window.history.replaceState({}, '', url);
    setStep('competitor-stock');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft || draft.localStatus === 'completed' || step !== 'actions' || !draft.stock || draft.prices) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'prices');
    window.history.replaceState({}, '', url);
    setStep('prices');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft || draft.localStatus === 'completed' || !['sales', 'scrap', 'review'].includes(step) || draft.commercialActions) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'actions');
    window.history.replaceState({}, '', url);
    setStep('actions');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft?.commercialActions || draft.localStatus === 'completed' ||
      !['scrap', 'review'].includes(step) || draft.sales) return;
    const url = new URL(window.location.href);
    url.searchParams.set('step', 'sales');
    window.history.replaceState({}, '', url);
    setShowCheckout(false);
    setStep('sales');
  }, [draft, state, step]);

  useEffect(() => {
    if (state !== 'ready' || !draft?.sales || draft.localStatus === 'completed' || step !== 'review' || draft.scrap) return;
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

  const returnToTasks = () => {
    if ((step === 'prices' && pricesDirty) || (step === 'sales' && salesDirty)) {
      setShowStockExit(true);
      return;
    }
    requestStockExit();
  };

  const savePrices = async (values: CompetitorPricesInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.savePrices(values);
    setPricesDirty(false);
    navigateStep('actions');
  };

  const saveCommercialActions = async (values: CommercialActionsInput) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveCommercialActions(values);
    navigateStep('sales');
  };

  const saveSales = async (values: VisitSalesInput, expectedVersion: number) => {
    const controller = controllerRef.current;
    if (!controller) throw new Error('A visita ainda não está pronta para edição.');
    await controller.saveSales(values, expectedVersion);
    setSalesDirty(false);
    navigateStep(recoveringSales ? 'complete' : 'start');
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

  const showStockStep = step === 'stock' && draft?.localStatus !== 'completed';

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
      {state === 'ready' && draft && <div className="seller-visit-start seller-active-visit">
        <div className="seller-context-bar seller-visit-context" aria-label={`Visita a ${draft.client?.name ?? 'cliente'}, etapa ${visitStepLabels[step]}`}>
          <span><strong>{draft.client?.name ?? 'Atendimento salvo'}</strong><small title={draft.client?.address}>{draft.client?.address ?? 'Endereço não informado'}</small></span>
          <span>{visitStepLabels[step]}</span>
        </div>
        <p className="seller-kicker">VISITA EM ANDAMENTO</p>
        <h1>{draft.client?.name ?? 'Atendimento salvo'}<span className="seller-heading-dot">.</span></h1>
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
        {recoveringSales && view.requiresLogin && <a className="seller-button seller-primary" href="/login">Entrar novamente</a>}
        {step === 'start' && draft.localStatus !== 'completed' && <section className="seller-task-list" aria-labelledby="visit-tasks-title">
          <p className="seller-kicker">TAREFAS DA VISITA</p>
          <h2 id="visit-tasks-title">O que você vai coletar?</h2>
          <button className="seller-task-card" data-state={stockComplete ? 'completed' : draft.stock ? 'in_progress' : 'available'} onClick={openStockCollection}
            aria-label={`Coleta de estoque, ${stockComplete ? 'concluída. Abrir detalhes' : 'pendente. Abrir coleta'}`}>
            <span><strong>Coleta de estoque</strong><small>Produtos próprios, concorrência e fotos</small></span>
            <span>{stockComplete ? '✓ Concluído' : draft.stock ? 'Continuar' : 'Iniciar'}</span>
          </button>
          <button className="seller-task-card" data-state={!stockComplete ? 'locked' : draft.prices ? 'completed' : 'available'} disabled={!stockComplete}
            onClick={() => navigateStep('prices')}>
            <span><strong>Pesquisa de preços</strong><small>Nossos produtos, concorrentes e indisponibilidade</small></span>
            <span>{draft.prices ? '✓ Concluído' : stockComplete ? 'Iniciar' : '🔒 Após estoque'}</span>
          </button>
          <button className="seller-task-card" data-state={!draft.prices ? 'locked' : draft.commercialActions ? 'completed' : 'available'} disabled={!draft.prices} onClick={() => navigateStep('actions')}>
            <span><strong>Ações comerciais</strong><small>Heliar e concorrência</small></span>
            <span>{draft.commercialActions ? '✓ Concluído' : draft.prices ? 'Iniciar' : '🔒 Após preços'}</span>
          </button>
          <button className="seller-task-card" data-state={!draft.commercialActions ? 'locked' : draft.sales ? 'completed' : 'available'} disabled={!draft.commercialActions}
            onClick={() => navigateStep('sales')}>
            <span><strong>Informe de venda na visita</strong><small>{draft.sales
              ? draft.sales.persistenceState === 'synced' ? 'Confirmado no servidor' : 'Salvo no aparelho'
              : 'Heliar, América e Strada/Durex'}</small></span>
            <span>{draft.sales ? '✓ Concluído' : draft.commercialActions ? 'Iniciar' : '🔒 Após ações'}</span>
          </button>
          <button className="seller-task-card" data-state={!draft.sales ? 'locked' : draft.scrap ? 'completed' : 'available'} disabled={!draft.sales} onClick={() => navigateStep('scrap')}>
            <span><strong>Sucata</strong><small>Coleta realizada, agendamento ou sem sucata</small></span>
            <span>{draft.scrap ? '✓ Concluído' : draft.sales ? 'Iniciar' : '🔒 Após informe de venda'}</span>
          </button>
        </section>}
        {showStockStep && <><p className="seller-kicker" role="status">ESTOQUE · ETAPA 1 DE 3 · PRODUTOS PRÓPRIOS</p><VisitStockStep
          key={draft.offlineId}
          draft={draft}
          onSave={saveStock}
          onContinue={() => navigateStep('competitor-stock')}
        /></>}
        {step === 'competitor-stock' && draft.localStatus !== 'completed' && draft.stock && <>
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
        {step === 'stock-photos' && draft.localStatus !== 'completed' && draft.stock && <VisitStockPhotosStep
          attachments={stockPhotos}
          onAdd={addStockPhoto}
          onRemove={removeStockPhoto}
          onDone={() => void completeStockCollection()}
        />}
        {step === 'prices' && draft.localStatus !== 'completed' && draft.stock && <VisitCompetitorPricesStep
          key={draft.prices?.eventId ?? 'new-prices'}
          draft={draft}
          parameters={view.priceParameters ?? null}
          onSave={savePrices}
          onDirtyChange={setPricesDirty}
        />}
        {step !== 'start' && step !== 'complete' && <button className="seller-button seller-secondary" type="button"
          onClick={returnToTasks}>Voltar</button>}
        {step === 'actions' && draft.localStatus !== 'completed' && draft.prices && <VisitCommercialActionsStep
          draft={draft} actions={view.commercialActions} parameters={view.priceParameters ?? null}
          attachments={view.attachments} onAddEvidence={addCommercialActionEvidence} onSave={saveCommercialActions}
        />}
        {step === 'sales' && draft.commercialActions && (draft.localStatus !== 'completed' || recoveringSales) && <>
          {recoveringSales && <p className="seller-notice" role="status">O checkout desta visita está preservado no aparelho. Informe as vendas para concluir o envio; não é necessário refazer as evidências.</p>}
          <VisitSalesStep
          key={draft.offlineId} draft={draft} onSave={saveSales} onDirtyChange={setSalesDirty} />
        </>}
        {step === 'scrap' && draft.localStatus !== 'completed' && draft.commercialActions && draft.sales && <VisitScrapStep draft={draft} attachments={view.attachments} points={view.scrapPoints}
          onSave={async (values) => { const controller = controllerRef.current; if (!controller) throw new Error('A visita ainda não está pronta.'); await controller.saveScrap(values); navigateStep('review'); }}
          onAddEvidence={async (collectionId, photo, name) => { const controller = controllerRef.current; if (!controller) throw new Error('A visita ainda não está pronta.'); return controller.addScrapEvidence(collectionId, photo, name); }} />}
        {step === 'review' && draft.localStatus !== 'completed' && draft.commercialActions && draft.sales && draft.scrap && <section className="seller-next-step" aria-labelledby="next-step-title">
          <p className="seller-kicker">AÇÕES COMERCIAIS</p>
          <h2 id="next-step-title" ref={nextStepTitleRef} tabIndex={-1}>
            {draft.commercialActions.persistenceState === 'synced' ? 'Sincronizadas' : 'Salvas no aparelho'}
          </h2>
          <p>{draft.commercialActions.ownAcknowledgements.length} ação(ões) Heliar confirmada(s) e {
            draft.commercialActions.competitor.availability === 'identified'
              ? `${draft.commercialActions.competitor.actions.length} ação(ões) concorrente(s) registrada(s).`
              : 'nenhuma ação concorrente identificada.'}</p>
          <p className="seller-notice">Revise as coletas e encerre a visita ainda na fachada da loja.</p>
          <p>Venda declarada na visita: Heliar {draft.sales.heliarQuantity} · América {draft.sales.americaQuantity} · Strada/Durex {draft.sales.stradaDurexQuantity} · {draft.sales.persistenceState === 'synced' ? 'Confirmada no servidor' : 'Salva no aparelho'}</p>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('sales')}>Editar informe de venda</button>
          <p>Sucata: {draft.scrap.availability === 'collected' ? `${draft.scrap.collection?.actualWeightKg} kg coletados · termo ${draft.scrap.collection?.receiptNumber}` : draft.scrap.availability === 'scheduled' ? `${draft.scrap.schedule?.estimatedWeightKg} kg previstos · ${draft.scrap.schedule?.desiredDate}` : 'Sem sucata'} · {draft.scrap.persistenceState === 'synced' ? 'Confirmada no servidor' : 'Salva no aparelho'}</p>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('scrap')}>Ver registro de sucata</button>
          <button className="seller-button seller-secondary" onClick={() => navigateStep('actions')}>Editar ações</button>
          <button className="seller-button seller-primary"
            onClick={() => setShowCheckout(true)}>Encerrar visita</button>
        </section>}
        {step === 'complete' && <section className="seller-next-step" aria-labelledby="visit-complete-title">
          <p className="seller-kicker">VISITA ENCERRADA</p>
          <h2 id="visit-complete-title">Checkout salvo no aparelho</h2>
          <p>Foto da fachada, posição e horário foram registrados. A sincronização ocorrerá quando a publicação privada estiver habilitada.</p>
          {recoveringSales && <>
            <p>{draft.sales ? 'Informe salvo. Ao conectar, verificaremos primeiro o checkout original; as vendas só serão enviadas se ele ainda estiver pendente.' : 'Falta o informe de venda para concluir o envio do checkout preservado.'}</p>
            <button className="seller-button seller-primary" onClick={() => navigateStep('sales')}>{draft.sales ? 'Editar informe pendente' : 'Informar vendas para concluir envio'}</button>
            <button className="seller-button seller-secondary" disabled={view.busy}
              onClick={() => void controllerRef.current?.resume()}>Tentar enviar checkout preservado</button>
          </>}
          {draft.salesRecoveryResolution && <p>O servidor já havia confirmado o checkout. O informe criado depois disso foi cancelado no aparelho; o registro dessa resolução foi preservado.</p>}
        </section>}
        {showCheckout && draft.sales && draft.localStatus !== 'completed' && draft.client && <div className="seller-evidence-overlay">
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
            <h2 id="stock-exit-title">{competitorDirty || pricesDirty || salesDirty ? 'Sair sem salvar?' : 'Pausar esta tarefa?'}</h2>
            <p id="stock-exit-description">{competitorDirty || pricesDirty || salesDirty
              ? 'As alterações ainda não salvas serão perdidas.'
              : 'A coleta ainda não foi concluída. Você poderá continuar depois.'}</p>
            <button className="seller-button seller-primary" autoFocus type="button"
              onClick={() => setShowStockExit(false)}>Continuar preenchendo</button>{' '}
            <button className="seller-button seller-secondary" type="button" onClick={() => {
              setCompetitorDirty(false); setPricesDirty(false); setSalesDirty(false); setShowStockExit(false); navigateStep('start');
            }}>Sair {competitorDirty || pricesDirty || salesDirty ? 'sem salvar' : 'agora'}</button>
          </section>
        </div>}
        {step === 'start' && draft.localStatus !== 'completed' && <button className="seller-button seller-secondary"
          type="button" onClick={() => setShowRouteExit(true)}>Pausar visita e voltar à rota</button>}
        {(step === 'complete' || recoveringSales) && <a className="seller-button seller-secondary" href="/route">Voltar à rota</a>}
        {showRouteExit && <div className="seller-evidence-overlay" role="dialog" aria-modal="true"
          aria-labelledby="route-exit-title" aria-describedby="route-exit-description">
          <section className="seller-stock-card">
            <h2 id="route-exit-title">Pausar visita e voltar à rota?</h2>
            <p id="route-exit-description">A visita continua em andamento. O que já foi salvo permanecerá neste aparelho.</p>
            <button className="seller-button seller-primary" autoFocus type="button"
              onClick={() => setShowRouteExit(false)}>Continuar a visita</button>{' '}
            <a className="seller-button seller-secondary" href="/route">Pausar e voltar à rota</a>
          </section>
        </div>}
      </div>}
    </main>
  </div>;
}
