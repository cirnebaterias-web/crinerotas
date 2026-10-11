import type {
  CompetitorPricesInput,
  CommercialActionsInput,
  VisitScrapInput,
  CommercialAction,
  ScrapPoint,
  LocalCompetitorPriceParameterSet,
  LocalVisitDraft,
  LocalAttachment,
  LocalVisitEvidence,
  StockInput,
} from '@cirne/contracts';
import type { OfflineFoundationService, OfflineSnapshot } from '@/lib/offline/service';
import type { CompressedStockPhoto } from './stock/stock-photo-compression';
import type { VisitEvidenceCaptureValue } from './visit-evidence-capture';

type VisitService = Pick<OfflineFoundationService,
  'initialize' | 'refresh' | 'synchronize' | 'saveVisitStock' | 'saveVisitPrices' |
  'listCommercialActions' | 'saveVisitCommercialActions' | 'saveVisitScrap' |
  'listScrapPoints' |
  'getVisitPriceParameters' | 'listVisitAttachments' | 'saveVisitAttachment' |
  'deleteVisitAttachment' | 'listVisitEvidence' | 'saveVisitEvidence' | 'close'>;

export interface VisitStartView {
  state: 'loading' | 'ready' | 'blocked' | 'missing';
  draft: LocalVisitDraft | null;
  message: string;
  busy: boolean;
  requiresLogin: boolean;
  priceParameters?: LocalCompetitorPriceParameterSet | null;
  commercialActions: CommercialAction[] | null;
  scrapPoints: ScrapPoint[];
  attachments: LocalAttachment[];
  evidence: LocalVisitEvidence[];
}

export const initialVisitView: VisitStartView = {
  state: 'loading', draft: null, message: '', busy: false, requiresLogin: false,
  priceParameters: null,
  commercialActions: null,
  scrapPoints: [],
  attachments: [],
  evidence: [],
};

/** Coordinates retries without creating a new intention or bypassing the outbox lease/backoff. */
export class VisitStartController {
  private active = true;
  private running: Promise<void> | null = null;
  private stockSaving: Promise<LocalVisitDraft> | null = null;
  private pricesSaving: Promise<LocalVisitDraft> | null = null;
  private actionsSaving: Promise<LocalVisitDraft> | null = null;
  private scrapSaving: Promise<LocalVisitDraft> | null = null;
  private priceParameters: LocalCompetitorPriceParameterSet | null = null;
  private commercialActions: CommercialAction[] | null = null;
  private scrapPoints: ScrapPoint[] = [];
  private attachments: LocalAttachment[] = [];
  private evidence: LocalVisitEvidence[] = [];
  private completionSaving: Promise<LocalVisitDraft> | null = null;
  private attachmentOperations = new Set<Promise<unknown>>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private evidenceRetryDelayMs = 30_000;
  private evidenceSyncDisabled = false;
  private scrapEvidenceSyncDisabled = false;
  private userId: string | undefined;
  private lastView: VisitStartView = initialVisitView;

  constructor(
    private readonly offlineId: string,
    private readonly service: VisitService,
    private readonly publish: (view: VisitStartView) => void,
    private readonly online: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  resume = (): Promise<void> => {
    if (!this.active) return Promise.resolve();
    if (this.running) return this.running;
    clearTimeout(this.retryTimer);
    this.running = this.run().catch(() => {
      clearTimeout(this.retryTimer);
      this.emit({ ...initialVisitView, state: 'blocked' });
    }).finally(() => {
      this.running = null;
      this.closeIfIdle();
    });
    return this.running;
  };

  blockAccess = () => {
    this.emit({ ...initialVisitView, state: 'blocked' });
    this.dispose();
  };

  saveStock(values: StockInput) {
    if (this.stockSaving) return this.stockSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const operation = this.persistStock(userId, values).finally(() => {
      if (this.stockSaving === operation) this.stockSaving = null;
      this.closeIfIdle();
    });
    this.stockSaving = operation;
    return operation;
  }

  savePrices(values: CompetitorPricesInput) {
    if (this.pricesSaving) return this.pricesSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const operation = this.persistPrices(userId, values).finally(() => {
      if (this.pricesSaving === operation) this.pricesSaving = null;
      this.closeIfIdle();
    });
    this.pricesSaving = operation;
    return operation;
  }

  saveCommercialActions(values: CommercialActionsInput) {
    if (this.actionsSaving) return this.actionsSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const operation = this.persistCommercialActions(userId, values).finally(() => {
      if (this.actionsSaving === operation) this.actionsSaving = null;
      this.closeIfIdle();
    });
    this.actionsSaving = operation;
    return operation;
  }

  saveScrap(values: VisitScrapInput) {
    if (this.scrapSaving) return this.scrapSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const operation = this.persistScrap(userId, values).finally(() => {
      if (this.scrapSaving === operation) this.scrapSaving = null;
      this.closeIfIdle();
    });
    this.scrapSaving = operation;
    return operation;
  }

  addScrapEvidence(collectionOfflineId: string, photo: CompressedStockPhoto, fileName: string) {
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    return this.trackAttachmentOperation((async () => {
      const attachment = await this.service.saveVisitAttachment({
        schemaVersion: 1, userId, offlineId: crypto.randomUUID(), visitOfflineId: this.offlineId,
        purpose: 'scrap_receipt', targetOfflineId: collectionOfflineId,
        fileName: (fileName.trim() || 'termo-sucata.jpg').slice(0, 160),
        contentType: photo.contentType, byteSize: photo.blob.size, width: photo.width, height: photo.height,
        checksum: photo.checksum, capturedAt: new Date(this.now()).toISOString(), status: 'pending', blob: photo.blob,
      });
      this.attachments = [...this.attachments, attachment].sort((left, right) =>
        left.capturedAt.localeCompare(right.capturedAt));
      this.emitCurrent('Foto do termo de sucata salva no aparelho.');
      return attachment;
    })());
  }

  addCommercialActionEvidence(targetOfflineId: string, photo: CompressedStockPhoto, fileName: string) {
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const previous = this.attachments.find((item) => item.purpose === 'commercial_action_evidence' && item.targetOfflineId === targetOfflineId);
    return this.trackAttachmentOperation((async () => {
      const attachment = await this.service.saveVisitAttachment({
        schemaVersion: 1, userId, offlineId: crypto.randomUUID(), visitOfflineId: this.offlineId,
        purpose: 'commercial_action_evidence', targetOfflineId,
        fileName: (fileName.trim() || 'evidencia-acao.jpg').slice(0, 160),
        contentType: photo.contentType, byteSize: photo.blob.size, width: photo.width, height: photo.height,
        checksum: photo.checksum, capturedAt: new Date(this.now()).toISOString(), status: 'pending', blob: photo.blob,
      });
      if (previous) await this.service.deleteVisitAttachment(userId, this.offlineId, previous.offlineId);
      this.attachments = [...this.attachments.filter((item) => item.offlineId !== previous?.offlineId), attachment];
      this.emitCurrent('Foto de evidência salva no aparelho.');
      return attachment;
    })());
  }

  addStockPhoto(photo: CompressedStockPhoto, fileName: string) {
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    return this.trackAttachmentOperation((async () => {
      const attachment = await this.service.saveVisitAttachment({
        schemaVersion: 1,
        userId,
        offlineId: crypto.randomUUID(),
        visitOfflineId: this.offlineId,
        purpose: 'stock_evidence',
        fileName: (fileName.trim() || 'foto-estoque.jpg').slice(0, 160),
        contentType: photo.contentType,
        byteSize: photo.blob.size,
        width: photo.width,
        height: photo.height,
        checksum: photo.checksum,
        capturedAt: new Date(this.now()).toISOString(),
        status: 'pending',
        blob: photo.blob,
      });
      this.attachments = [...this.attachments, attachment].sort((left, right) =>
        left.capturedAt.localeCompare(right.capturedAt));
      this.emitCurrent('Foto comprimida e salva no aparelho.');
    })());
  }

  removeStockPhoto(offlineId: string) {
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    return this.trackAttachmentOperation((async () => {
      await this.service.deleteVisitAttachment(userId, this.offlineId, offlineId);
      this.attachments = this.attachments.filter((attachment) => attachment.offlineId !== offlineId);
      this.emitCurrent('Foto removida do aparelho.');
    })());
  }

  completeVisit(value: VisitEvidenceCaptureValue) {
    if (this.completionSaving) return this.completionSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para encerramento.');
    const operation = this.service.saveVisitEvidence({
      userId,
      visitOfflineId: this.offlineId,
      kind: 'checkout',
      ...value,
    }).then(({ evidence, draft }) => {
      this.evidence = [...this.evidence.filter((item) => item.kind !== 'checkout'), evidence];
      this.emit({
        ...this.lastView,
        state: 'ready',
        draft,
        message: 'Visita encerrada e salva no aparelho.',
        busy: false,
        requiresLogin: false,
        evidence: this.evidence,
      });
      if (this.active && this.online()) this.synchronizeAfterCommit();
      return draft;
    }).finally(() => {
      if (this.completionSaving === operation) this.completionSaving = null;
      this.closeIfIdle();
    });
    this.completionSaving = operation;
    return operation;
  }

  private emitCurrent(message: string) {
    if (this.lastView.state === 'ready') {
      this.emit({ ...this.lastView, message, attachments: this.attachments, evidence: this.evidence });
    }
  }

  private async persistStock(
    userId: string,
    values: StockInput,
  ) {
    const saved = await this.service.saveVisitStock({
      userId,
      offlineId: this.offlineId,
      ...values,
    });
    this.emit({
      state: 'ready',
      draft: saved.draft,
      message: 'Estoque salvo no aparelho.',
      busy: false,
      requiresLogin: false,
      priceParameters: this.priceParameters,
      commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
      attachments: this.attachments,
      evidence: this.evidence,
    });
    if (this.active && this.online()) this.synchronizeAfterCommit();
    return saved.draft;
  }

  private async persistPrices(userId: string, values: CompetitorPricesInput) {
    const saved = await this.service.saveVisitPrices({
      userId,
      offlineId: this.offlineId,
      values,
    });
    this.emit({
      state: 'ready',
      draft: saved.draft,
      message: 'Preços salvos no aparelho.',
      busy: false,
      requiresLogin: false,
      priceParameters: this.priceParameters,
      commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
      attachments: this.attachments,
      evidence: this.evidence,
    });
    if (this.active && this.online()) this.synchronizeAfterCommit();
    return saved.draft;
  }

  private async persistCommercialActions(userId: string, values: CommercialActionsInput) {
    const saved = await this.service.saveVisitCommercialActions({ userId, offlineId: this.offlineId, values });
    this.emit({
      state: 'ready', draft: saved.draft, message: 'Ações comerciais salvas no aparelho.', busy: false,
      requiresLogin: false, priceParameters: this.priceParameters, commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
      attachments: this.attachments, evidence: this.evidence,
    });
    if (this.active && this.online()) this.synchronizeAfterCommit();
    return saved.draft;
  }

  private async persistScrap(userId: string, values: VisitScrapInput) {
    const saved = await this.service.saveVisitScrap({ userId, offlineId: this.offlineId, values });
    this.emit({
      state: 'ready', draft: saved.draft, message: 'Sucata salva no aparelho.', busy: false,
      requiresLogin: false, priceParameters: this.priceParameters, commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
      attachments: this.attachments, evidence: this.evidence,
    });
    if (this.active && this.online()) this.synchronizeAfterCommit();
    return saved.draft;
  }

  private synchronizeAfterCommit() {
    const inFlight = this.running;
    if (!inFlight) {
      void this.resume();
      return;
    }
    // A run that started before the local commit cannot have reserved the new event.
    // Queue a fresh snapshot after it settles so the online save is not left waiting
    // for an unrelated foreground/reconnect signal.
    void inFlight.then(
      () => { if (this.active && this.online()) void this.resume(); },
      () => { if (this.active && this.online()) void this.resume(); },
    );
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.retryTimer);
    // Let an already-sent confirmation finish its durable local commit before closing Dexie.
    this.closeIfIdle();
  }

  private closeIfIdle() {
    if (!this.active && !this.running && !this.stockSaving && !this.pricesSaving &&
      !this.actionsSaving && !this.scrapSaving && !this.completionSaving &&
      this.attachmentOperations.size === 0) this.service.close();
  }

  private trackAttachmentOperation<T>(operation: Promise<T>): Promise<T> {
    this.attachmentOperations.add(operation);
    void operation.then(
      () => { this.attachmentOperations.delete(operation); this.closeIfIdle(); },
      () => { this.attachmentOperations.delete(operation); this.closeIfIdle(); },
    );
    return operation;
  }

  private emit(view: VisitStartView) {
    this.lastView = view;
    if (this.active) this.publish(view);
  }

  private current(snapshot: OfflineSnapshot) {
    return snapshot.drafts.find((draft) => draft.offlineId === this.offlineId);
  }

  private async run() {
    const snapshot = await this.service.initialize();
    if (!this.active) return;
    if (snapshot.kind !== 'ready') {
      this.emit({ ...initialVisitView, state: snapshot.kind === 'blocked' ? 'blocked' : 'missing' });
      return;
    }
    if (this.userId && snapshot.partition.userId !== this.userId) {
      this.emit({ ...initialVisitView, state: 'blocked' });
      return;
    }
    this.userId = snapshot.partition.userId;
    const draft = this.current(snapshot);
    if (!draft) {
      this.emit({ ...initialVisitView, state: 'missing' });
      return;
    }
    this.priceParameters = await this.service.getVisitPriceParameters(
      snapshot.partition.userId,
      this.offlineId,
    ) ?? null;
    this.commercialActions = await this.service.listCommercialActions(snapshot.partition.userId).catch(() => null);
    this.scrapPoints = await this.service.listScrapPoints(snapshot.partition.userId).catch(() => []);
    this.attachments = await this.service.listVisitAttachments(
      snapshot.partition.userId,
      this.offlineId,
    );
    this.evidence = await this.service.listVisitEvidence(
      snapshot.partition.userId,
      this.offlineId,
    );
    if (!this.active) return;
    this.show(snapshot);
    const scrapPhotoPending = this.attachments.some((item) =>
      item.purpose === 'scrap_receipt' && item.status === 'pending');
    if (!this.online() || (draft.persistenceState === 'synced' &&
      !this.evidence.some((item) => item.status === 'pending') && !scrapPhotoPending)) return;
    const event = snapshot.outbox.find((candidate) => candidate.aggregateId === this.offlineId);
    const evidencePending = this.evidence.some((item) => item.status === 'pending') || scrapPhotoPending;
    if (event?.status === 'action_required' || (!event && !evidencePending)) return;
    clearTimeout(this.retryTimer);
    this.emit({
      state: 'ready', draft, message: 'Sincronizando em segundo plano…', busy: true,
      requiresLogin: false, priceParameters: this.priceParameters, attachments: this.attachments,
      commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
      evidence: this.evidence,
    });
    const summary = await this.service.synchronize(snapshot.partition);
    if (!this.active) return;
    this.evidenceSyncDisabled = Boolean(summary.evidenceDisabled);
    this.scrapEvidenceSyncDisabled = Boolean(summary.scrapEvidenceDisabled);
    this.evidenceRetryDelayMs = summary.recoverable > 0
      ? Math.min(this.evidenceRetryDelayMs * 2, 5 * 60_000)
      : 30_000;
    const refreshed = await this.service.refresh(snapshot.partition);
    if (!this.active) return;
    if (refreshed.kind !== 'ready') {
      this.emit({ ...initialVisitView, state: 'blocked' });
      return;
    }
    this.attachments = await this.service.listVisitAttachments(
      refreshed.partition.userId, this.offlineId,
    );
    this.evidence = await this.service.listVisitEvidence(
      refreshed.partition.userId, this.offlineId,
    );
    this.show(refreshed, summary.authenticationRequired);
  }

  private show(snapshot: OfflineSnapshot, authenticationRequired = false) {
    clearTimeout(this.retryTimer);
    const draft = this.current(snapshot);
    if (!draft) {
      this.emit({ ...initialVisitView, state: 'missing' });
      return;
    }
    const event = snapshot.outbox.find((candidate) => candidate.aggregateId === this.offlineId);
    const requiresLogin = authenticationRequired || event?.lastErrorCode === 'AUTH_REQUIRED';
    let message = 'Salvo no aparelho. A sincronização tentará novamente.';
    const evidenceActionRequired = this.evidence.some((item) => item.status === 'action_required') ||
      this.attachments.some((item) => item.purpose === 'scrap_receipt' && item.status === 'action_required');
    const visitEvidencePending = this.evidence.some((item) => item.status === 'pending');
    const scrapEvidencePending = this.attachments.some((item) =>
      item.purpose === 'scrap_receipt' && item.status === 'pending');
    const evidencePending = visitEvidencePending || scrapEvidencePending;
    if (evidenceActionRequired && draft.persistenceState === 'synced') {
      message = 'Dados confirmados; uma evidência exige revisão antes do envio.';
    }
    else if (evidencePending && draft.persistenceState === 'synced') {
      message = 'Dados confirmados; evidências protegidas no aparelho aguardam o canal privado.';
    } else if (draft.persistenceState === 'synced') message = 'Registro da visita confirmado pelo servidor.';
    else if (requiresLogin) message = 'Salvo no aparelho. Entre novamente com o mesmo vendedor para sincronizar.';
    else if (event?.status === 'action_required') message = 'Salvo no aparelho. A sincronização exige revisão; nenhuma visita foi descartada.';
    else if (!this.online()) message = 'Salvo no aparelho. A sincronização será retomada quando a conexão voltar.';
    else if (event) {
      const due = event.status === 'sending' ? event.leaseUntil : event.nextAttemptAt;
      const delay = due ? Math.max(250, Date.parse(due) - this.now()) : 1_000;
      this.retryTimer = setTimeout(() => { void this.resume(); }, delay);
    }
    const retryableEvidencePending = (visitEvidencePending && !this.evidenceSyncDisabled)
      || (scrapEvidencePending && !this.scrapEvidenceSyncDisabled);
    if (!event && retryableEvidencePending && !evidenceActionRequired && this.online() && !requiresLogin) {
      this.retryTimer = setTimeout(() => { void this.resume(); }, this.evidenceRetryDelayMs);
    }
    this.emit({
      state: 'ready', draft, message, busy: false, requiresLogin,
      priceParameters: this.priceParameters, attachments: this.attachments, evidence: this.evidence,
      commercialActions: this.commercialActions,
      scrapPoints: this.scrapPoints,
    });
  }
}
