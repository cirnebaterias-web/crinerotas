import type { LocalVisitDraft } from '@cirne/contracts';
import type { OfflineFoundationService, OfflineSnapshot } from '@/lib/offline/service';

type VisitService = Pick<OfflineFoundationService,
  'initialize' | 'refresh' | 'synchronize' | 'saveVisitStock' | 'close'>;

export interface VisitStartView {
  state: 'loading' | 'ready' | 'blocked' | 'missing';
  draft: LocalVisitDraft | null;
  message: string;
  busy: boolean;
  requiresLogin: boolean;
}

export const initialVisitView: VisitStartView = {
  state: 'loading', draft: null, message: '', busy: false, requiresLogin: false,
};

/** Coordinates retries without creating a new intention or bypassing the outbox lease/backoff. */
export class VisitStartController {
  private active = true;
  private running: Promise<void> | null = null;
  private stockSaving: Promise<LocalVisitDraft> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private userId: string | undefined;

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
      if (!this.active && !this.stockSaving) this.service.close();
    });
    return this.running;
  };

  blockAccess = () => {
    this.emit({ ...initialVisitView, state: 'blocked' });
    this.dispose();
  };

  saveStock(values: { heliarQuantity: number; mouraQuantity: number; observation?: string }) {
    if (this.stockSaving) return this.stockSaving;
    const userId = this.userId;
    if (!this.active || !userId) throw new Error('A visita ainda não está pronta para edição.');
    const operation = this.persistStock(userId, values).finally(() => {
      if (this.stockSaving === operation) this.stockSaving = null;
      if (!this.active && !this.running) this.service.close();
    });
    this.stockSaving = operation;
    return operation;
  }

  private async persistStock(
    userId: string,
    values: { heliarQuantity: number; mouraQuantity: number; observation?: string },
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
    });
    if (this.active && this.online()) this.synchronizeAfterStock();
    return saved.draft;
  }

  private synchronizeAfterStock() {
    const inFlight = this.running;
    if (!inFlight) {
      void this.resume();
      return;
    }
    // A run that started before the stock commit cannot have reserved the new event.
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
    if (!this.running && !this.stockSaving) this.service.close();
  }

  private emit(view: VisitStartView) {
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
    this.show(snapshot);
    if (!this.online() || draft.persistenceState === 'synced') return;
    const event = snapshot.outbox.find((candidate) => candidate.aggregateId === this.offlineId);
    if (!event || event.status === 'action_required') return;
    clearTimeout(this.retryTimer);
    this.emit({ state: 'ready', draft, message: 'Sincronizando em segundo plano…', busy: true, requiresLogin: false });
    const summary = await this.service.synchronize(snapshot.partition);
    if (!this.active) return;
    const refreshed = await this.service.refresh(snapshot.partition);
    if (!this.active) return;
    if (refreshed.kind !== 'ready') {
      this.emit({ ...initialVisitView, state: 'blocked' });
      return;
    }
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
    if (draft.persistenceState === 'synced') message = 'Início confirmado pelo servidor.';
    else if (requiresLogin) message = 'Salvo no aparelho. Entre novamente com o mesmo vendedor para sincronizar.';
    else if (event?.status === 'action_required') message = 'Salvo no aparelho. A sincronização exige revisão; nenhuma visita foi descartada.';
    else if (!this.online()) message = 'Salvo no aparelho. A sincronização será retomada quando a conexão voltar.';
    else if (event) {
      const due = event.status === 'sending' ? event.leaseUntil : event.nextAttemptAt;
      const delay = due ? Math.max(250, Date.parse(due) - this.now()) : 1_000;
      this.retryTimer = setTimeout(() => { void this.resume(); }, delay);
    }
    this.emit({ state: 'ready', draft, message, busy: false, requiresLogin });
  }
}
