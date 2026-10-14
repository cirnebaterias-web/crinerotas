'use client';

import {
  competitorPriceParameterSetSchema,
  commercialActionListSchema,
  commercialActionsPath,
  scrapPointListSchema,
  scrapPointsPath,
  currentParameterSetPath,
  mePath,
  meResponseSchema,
  type AnyCanonicalLocalRouteBundle,
  type CanonicalRoute,
  type LocalRouteBundle,
  type CompetitorPricesInput,
  type CommercialActionsInput,
  type VisitScrapInput,
  type ScrapPoint,
  type CommercialAction,
  type OwnStockLine,
  type StockInput,
  type LocalAttachment,
  localAttachmentMetadataSchema,
  localVisitEvidenceSchema,
  type LocalVisitEvidence,
  type VisitEvidenceIssue,
  type CompetitorStockLine,
  type OfflinePartition,
} from '@cirne/contracts';
import {
  createCanonicalLocalRouteBundle,
  createSyntheticRouteBundle,
  createValidatedLocalSession,
  evaluateLocalAccess,
  type DraftMutationIds,
} from '@cirne/domain';
import { OfflineDatabase } from './database';
import {
  OfflineRepository,
  type SaveDraftCommand,
  type SaveVisitStartCommand,
  type SaveVisitStockCommand,
  type SaveVisitPricesCommand,
  type SaveVisitCommercialActionsCommand,
  type SaveVisitScrapCommand,
} from './repository';
import { SyncEngine, type RefreshSession, type SyncRunSummary } from './sync-engine';
import { FetchSyncTransport } from './sync-transport';
import { EvidenceSyncCoordinator, FetchEvidenceSyncTransport } from './evidence-sync';
import { FetchScrapEvidenceTransport, ScrapEvidenceSyncCoordinator } from './scrap-evidence-sync';
import {
  isCurrentOfflineRevisionResponse,
  offlineRevisionRequestType,
} from './cache-policy';

export interface OfflineSyncRunSummary extends SyncRunSummary {
  evidenceDisabled: boolean;
  scrapEvidenceDisabled: boolean;
}

const deviceStorageKey = 'cirne-rotas.device-id';
const userStorageKey = 'cirne-rotas.last-user-id';
export const syntheticSellerId = '11111111-1111-4111-8111-111111111111';

export interface OfflineSnapshot {
  kind: 'ready';
  partition: OfflinePartition;
  routes: Awaited<ReturnType<OfflineRepository['listRouteBundles']>>;
  drafts: Awaited<ReturnType<OfflineRepository['listDrafts']>>;
  outbox: Awaited<ReturnType<OfflineRepository['listOutbox']>>;
  workerReady: boolean;
  storagePersisted: boolean;
}

export type OfflineShellResult =
  | OfflineSnapshot
  | { kind: 'empty'; demoAvailable: boolean; message: string }
  | { kind: 'blocked'; reason: 'authentication_required' | 'session_expired' | 'clock_rollback'; message: string };

const revokedResult: OfflineShellResult = {
  kind: 'blocked', reason: 'authentication_required',
  message: 'O acesso local foi bloqueado. Entre novamente para continuar; os pendentes foram preservados.',
};

export interface CanonicalRouteCacheResult {
  bundle: AnyCanonicalLocalRouteBundle;
  workerReady: boolean;
  storagePersisted: boolean;
  availableOffline: boolean;
  compositionUpdated: boolean;
}

function isLoopback() {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
}

function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem(deviceStorageKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(deviceStorageKey, created);
  return created;
}

async function waitForWorkerRegistration(signal?: AbortSignal) {
  return new Promise<ServiceWorkerRegistration | undefined>((resolve) => {
    let settled = false;
    const aborted = () => finish(undefined);
    const timeout = window.setTimeout(() => finish(undefined), 10_000);
    const finish = (registration: ServiceWorkerRegistration | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      resolve(registration);
    };
    signal?.addEventListener('abort', aborted, { once: true });
    void navigator.serviceWorker.ready.then(
      (registration) => finish(registration),
      () => finish(undefined),
    );
    if (signal?.aborted) finish(undefined);
  });
}

async function workerIsReady(waitForInstall: boolean, signal?: AbortSignal) {
  if (!('serviceWorker' in navigator)) return false;
  const expectedRevision = process.env.NEXT_PUBLIC_OFFLINE_REVISION;
  if (!expectedRevision) return false;

  const registration = waitForInstall
    ? await waitForWorkerRegistration(signal)
    : await navigator.serviceWorker.getRegistration();
  if (signal?.aborted) return false;
  const worker = registration?.active;
  if (!worker) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const channel = new MessageChannel();
    const aborted = () => finish(false);
    const timeout = window.setTimeout(() => finish(false), 2_000);
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      resolve(ready);
    };
    channel.port1.onmessage = (event) => {
      finish(isCurrentOfflineRevisionResponse(event.data, expectedRevision));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    worker.postMessage({ type: offlineRevisionRequestType }, [channel.port2]);
    if (signal?.aborted) finish(false);
  });
}

async function storageIsPersisted() {
  if (!navigator.storage?.persisted) return false;
  try { return await navigator.storage.persisted(); } catch { return false; }
}

async function requestStoragePersistence() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

export async function refreshBrowserSession(): Promise<boolean> {
  try {
    // The server-scoped Supabase client consumes the refresh cookie and returns replacements on this request.
    const response = await fetch(mePath, { credentials: 'same-origin', cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

function saoPauloDate(instant: string) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Data local inválida.');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function currentCommercialActions(actions: CommercialAction[], today: string) {
  return actions.filter((action) => action.active && action.validFrom <= today && action.validUntil >= today);
}

export class OfflineFoundationService {
  private readonly repository: OfflineRepository;
  private readonly syncEngine: SyncEngine;
  private readonly evidenceSync: EvidenceSyncCoordinator;
  private readonly scrapEvidenceSync: ScrapEvidenceSyncCoordinator;
  private currentDeviceId: string | null = null;
  private revocationBarrier: Promise<void> | null = null;
  private readonly persistenceOperations = new Set<Promise<CanonicalRouteCacheResult>>();
  private readonly revocationController = new AbortController();
  private accessRevoked = false;

  constructor(
    database = new OfflineDatabase(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    refreshSession: RefreshSession = refreshBrowserSession,
  ) {
    this.repository = new OfflineRepository(database);
    this.syncEngine = new SyncEngine(this.repository, new FetchSyncTransport(), refreshSession);
    this.evidenceSync = new EvidenceSyncCoordinator(this.repository, new FetchEvidenceSyncTransport());
    this.scrapEvidenceSync = new ScrapEvidenceSyncCoordinator(this.repository, new FetchScrapEvidenceTransport());
  }

  async initialize(): Promise<OfflineShellResult> {
    if (this.accessRevoked) return revokedResult;
    await this.repository.open();
    if (this.accessRevoked) return revokedResult;
    const deviceId = this.getDeviceId();
    const previousUserId = window.localStorage.getItem(userStorageKey);

    if (navigator.onLine) {
      try {
        const response = await fetch(mePath, { credentials: 'same-origin', cache: 'no-store' });
        if (this.accessRevoked) return revokedResult;
        if (response.ok) {
          const identity = meResponseSchema.parse(await response.json());
          if (this.accessRevoked) return revokedResult;
          if (!identity.roles.includes('seller') || identity.status !== 'active') {
            await this.invalidateLocalAccess(deviceId, previousUserId, identity.id);
            return { kind: 'blocked', reason: 'authentication_required', message: 'Acesso de vendedor ativo necessário.' };
          }
          const partition = { userId: identity.id, deviceId };
          if (previousUserId && previousUserId !== identity.id) {
            await this.invalidateLocalAccess(deviceId, previousUserId);
          }
          if (this.accessRevoked) return revokedResult;
          await this.repository.saveLocalSession(createValidatedLocalSession(partition, this.now()));
          if (this.accessRevoked) {
            await this.invalidateLocalAccess(deviceId, identity.id);
            return revokedResult;
          }
          window.localStorage.setItem(userStorageKey, identity.id);
          return this.loadAuthorizedPartition(partition, true);
        }
        if (response.status === 401 || response.status === 403) {
          if (isLoopback() && previousUserId === syntheticSellerId) {
            return this.loadAuthorizedPartition({ userId: previousUserId, deviceId }, true);
          }
          await this.invalidateLocalAccess(deviceId, previousUserId);
          if (isLoopback()) {
            return {
              kind: 'empty',
              demoAvailable: true,
              message: 'Nenhum pacote offline disponível. Entre online ou carregue a demonstração sintética local.',
            };
          }
          return { kind: 'blocked', reason: 'authentication_required', message: 'Acesso de vendedor ativo necessário.' };
        }
      } catch {
        // A falha online não autoriza leitura. A exceção abaixo é exclusivamente a fixture local explícita.
      }
      if (this.accessRevoked) return revokedResult;
      if (!(isLoopback() && previousUserId === syntheticSellerId)) {
        return {
          kind: 'empty',
          demoAvailable: isLoopback(),
          message: 'Nenhum pacote offline disponível. Entre online ou carregue a demonstração sintética local.',
        };
      }
    }

    if (!previousUserId) {
      return { kind: 'empty', demoAvailable: isLoopback() && navigator.onLine, message: 'Nenhum pacote offline foi carregado neste aparelho.' };
    }
    return this.loadAuthorizedPartition({ userId: previousUserId, deviceId }, navigator.onLine);
  }

  async provisionSyntheticRoute(): Promise<OfflineSnapshot> {
    if (!isLoopback()) throw new Error('A demonstração sintética só é permitida em origem local.');
    await this.repository.open();
    const workerReady = await workerIsReady(true);
    if (!workerReady) throw new Error('O shell offline ainda não terminou de instalar. Tente novamente.');
    const partition = { userId: syntheticSellerId, deviceId: this.getDeviceId() };
    const timestamp = this.now();
    const bundle = createSyntheticRouteBundle(partition, timestamp);
    const session = createValidatedLocalSession(partition, timestamp);
    const storagePersisted = await requestStoragePersistence();
    await this.repository.saveValidatedRoute(bundle, session);
    window.localStorage.setItem(userStorageKey, partition.userId);
    const loaded = await this.loadAuthorizedPartition(partition, false, { workerReady, storagePersisted });
    if (loaded.kind !== 'ready') throw new Error('A sessão sintética local não pôde ser validada.');
    return loaded;
  }

  async cacheCanonicalRoute(userId: string, route: CanonicalRoute): Promise<CanonicalRouteCacheResult> {
    if (this.accessRevoked || this.revocationBarrier) {
      throw new Error('O acesso local está sendo revogado.');
    }
    const operation = this.persistCanonicalRoute(userId, route);
    this.persistenceOperations.add(operation);
    void operation.then(
      () => this.persistenceOperations.delete(operation),
      () => this.persistenceOperations.delete(operation),
    );
    return operation;
  }

  async cacheCompetitorPriceParameters(userId: string, serviceDate: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de carregar parâmetros.');
    return this.fetchAndCachePriceParameterSet(partition, `${serviceDate}T12:00:00.000Z`);
  }

  async getVisitPriceParameters(userId: string, offlineId: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) return undefined;
    const draft = await this.repository.getDraft(partition, offlineId);
    if (!draft) return undefined;
    if (draft.parameterSetId) {
      const cached = await this.repository.getPriceParameterSet(partition, draft.parameterSetId);
      if (cached || !draft.deviceStartedAt || !navigator.onLine) return cached;
      return this.fetchAndCachePriceParameterSet(
        partition,
        draft.deviceStartedAt,
        draft.parameterSetId,
      ).catch(() => undefined);
    }
    const routes = await this.repository.listRouteBundles(partition);
    const route = routes.find((candidate) => candidate.stops.some(
      (stop) => stop.routeVersionStopId === draft.routeVersionStopId,
    ));
    if (!route) return undefined;
    return this.repository.findPriceParameterSetAt(
      partition,
      `${route.serviceDate}T12:00:00.000Z`,
    );
  }

  private async fetchAndCachePriceParameterSet(
    partition: OfflinePartition,
    at: string,
    expectedParameterSetId?: string,
  ) {
    const response = await fetch(`${currentParameterSetPath}?at=${encodeURIComponent(at)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('Não foi possível carregar o catálogo de Preços.');
    const catalog = competitorPriceParameterSetSchema.parse(await response.json());
    if (expectedParameterSetId && catalog.parameterSetId !== expectedParameterSetId) {
      throw new Error('O catálogo retornado não corresponde ao conjunto confirmado da visita.');
    }
    return this.repository.savePriceParameterSet({
      ...catalog,
      ...partition,
      cachedAt: this.now(),
    });
  }

  private async persistCanonicalRoute(userId: string, route: CanonicalRoute): Promise<CanonicalRouteCacheResult> {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const timestamp = this.now();
    const bundle = createCanonicalLocalRouteBundle(partition, route, timestamp);
    const session = createValidatedLocalSession(partition, timestamp);
    const previous = await this.repository.getRouteBundle(partition, route.routeId);
    const [workerReady, storagePersisted] = await Promise.all([
      workerIsReady(true, this.revocationController.signal),
      requestStoragePersistence(),
    ]);
    if (this.accessRevoked) throw new Error('O acesso local foi revogado.');
    const stored = await this.repository.saveValidatedRoute(bundle, session);
    if (stored.schemaVersion !== 2 && stored.schemaVersion !== 3) {
      throw new Error('O snapshot canônico não foi persistido.');
    }
    if (this.accessRevoked) {
      await this.invalidateLocalAccess(partition.deviceId, partition.userId);
      throw new Error('O acesso local foi revogado.');
    }
    window.localStorage.setItem(userStorageKey, userId);
    const compositionUpdated = stored.schemaVersion === 3 && stored.compositionChange !== null &&
      stored.routeVersionId === bundle.routeVersionId &&
      (!(previous?.schemaVersion === 2 || previous?.schemaVersion === 3) ||
        previous.versionNumber < stored.versionNumber);
    return { bundle: stored, workerReady, storagePersisted, availableOffline: workerReady, compositionUpdated };
  }

  /** Fence this instance without deleting a different user's newly established session. */
  blockLocalAccess() {
    this.accessRevoked = true;
    this.revocationController.abort();
  }

  revokeLocalAccess(userId?: string) {
    if (this.revocationBarrier) return this.revocationBarrier;
    this.blockLocalAccess();
    let targetUserId = userId;
    try { targetUserId ??= window.localStorage.getItem(userStorageKey) ?? undefined; } catch { /* Explicit identity remains usable when storage fails. */ }
    const operation = this.performLocalRevocation(targetUserId).finally(() => {
      if (this.revocationBarrier === operation) this.revocationBarrier = null;
    });
    this.revocationBarrier = operation;
    return operation;
  }

  private async performLocalRevocation(userId?: string) {
    await Promise.allSettled([...this.persistenceOperations]);
    await this.repository.open();
    const deviceId = this.getDeviceId();
    await this.invalidateLocalAccess(deviceId, userId ?? null);
  }

  createDraftCommand(bundle: LocalRouteBundle, currentDraftOfflineId?: string): SaveDraftCommand {
    const ids: DraftMutationIds = {
      draftOfflineId: currentDraftOfflineId ?? this.createId(),
      eventId: this.createId(),
      idempotencyKey: this.createId(),
    };
    return {
      partition: { userId: bundle.userId, deviceId: bundle.deviceId },
      routeVersionStopId: bundle.stops[0]!.routeVersionStopId,
      acknowledged: true,
      occurredAt: this.now(),
      ids,
    };
  }

  async saveDraft(command: SaveDraftCommand) {
    const access = await this.requireLocalAccess(command.partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de editar.');
    return this.repository.saveDraftAndEnqueue(command);
  }

  async startVisit(input: {
    userId: string;
    routeVersionStopId: string;
    location?: SaveVisitStartCommand['location'];
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de iniciar.');
    return this.repository.saveVisitStartAndEnqueue({
      partition,
      routeVersionStopId: input.routeVersionStopId,
      deviceStartedAt: this.now(),
      ...(input.location ? { location: input.location } : {}),
      ids: {
        offlineId: this.createId(),
        eventId: this.createId(),
        idempotencyKey: this.createId(),
      },
    });
  }

  async findVisitForStop(userId: string, routeVersionStopId: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) return undefined;
    return this.repository.findDraftForStop(partition, routeVersionStopId);
  }

  async listVisitAttachments(userId: string, visitOfflineId: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de acessar fotos.');
    return this.repository.listVisitAttachments(partition, visitOfflineId);
  }

  async saveVisitAttachment(input: Omit<LocalAttachment, 'userId' | 'deviceId'> & { userId: string }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de salvar fotos.');
    const { blob, ...metadataInput } = input;
    const metadata = localAttachmentMetadataSchema.parse({
      ...metadataInput,
      deviceId: partition.deviceId,
    });
    return this.repository.saveVisitAttachment(partition, { ...metadata, blob });
  }

  async deleteVisitAttachment(userId: string, visitOfflineId: string, offlineId: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de remover fotos.');
    return this.repository.deleteVisitAttachment(partition, visitOfflineId, offlineId);
  }

  async saveVisitEvidence(input: {
    userId: string;
    visitOfflineId: string;
    kind: 'checkin' | 'checkout';
    capturedAt: string;
    location?: { latitude: string; longitude: string; accuracyM: string; distanceM?: string };
    issues: VisitEvidenceIssue[];
    justification?: string;
    photo?: { blob: Blob; contentType: 'image/jpeg'; width: number; height: number; checksum: string };
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de salvar a evidência.');
    const attachmentId = input.photo ? this.createId() : undefined;
    const expiresAt = new Date(new Date(input.capturedAt).getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const evidence: LocalVisitEvidence = localVisitEvidenceSchema.parse({
      schemaVersion: 1,
      ...partition,
      offlineId: this.createId(),
      visitOfflineId: input.visitOfflineId,
      kind: input.kind,
      ...(attachmentId ? { attachmentOfflineId: attachmentId } : {}),
      capturedAt: input.capturedAt,
      ...(input.location ?? {}),
      radiusM: 100,
      desiredAccuracyM: 50,
      issues: input.issues,
      ...(input.justification?.trim() ? { justification: input.justification.trim() } : {}),
      status: 'pending',
      expiresAt,
    });
    const attachment: LocalAttachment | undefined = input.photo && attachmentId ? {
      schemaVersion: 1,
      ...partition,
      offlineId: attachmentId,
      visitOfflineId: input.visitOfflineId,
      purpose: input.kind === 'checkin' ? 'visit_checkin' : 'visit_checkout',
      fileName: `${input.kind}-fachada.jpg`,
      contentType: input.photo.contentType,
      byteSize: input.photo.blob.size,
      width: input.photo.width,
      height: input.photo.height,
      checksum: input.photo.checksum,
      capturedAt: input.capturedAt,
      status: 'pending',
      blob: input.photo.blob,
    } : undefined;
    return this.repository.saveVisitEvidence(partition, evidence, attachment);
  }

  async listVisitEvidence(userId: string, visitOfflineId: string) {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de acessar evidências.');
    return this.repository.listVisitEvidence(partition, visitOfflineId);
  }

  async saveVisitStock(input: {
    userId: string;
    offlineId: string;
    heliarQuantity: number;
    mouraQuantity: number;
    observation?: string;
    ownLines?: OwnStockLine[];
    completedOwnBrands?: StockInput['completedOwnBrands'];
    competitorLines?: CompetitorStockLine[];
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de editar.');
    const command: SaveVisitStockCommand = {
      partition,
      offlineId: input.offlineId,
      heliarQuantity: input.heliarQuantity,
      mouraQuantity: input.mouraQuantity,
      ...(input.observation === undefined ? {} : { observation: input.observation }),
      ...(input.ownLines ? { ownLines: input.ownLines } : {}),
      ...(input.completedOwnBrands ? { completedOwnBrands: input.completedOwnBrands } : {}),
      ...(input.competitorLines ? { competitorLines: input.competitorLines } : {}),
      deviceSavedAt: this.now(),
      ids: { eventId: this.createId(), idempotencyKey: this.createId() },
    };
    return this.repository.saveVisitStockAndEnqueue(command);
  }

  async saveVisitPrices(input: {
    userId: string;
    offlineId: string;
    values: CompetitorPricesInput;
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de editar.');
    const command: SaveVisitPricesCommand = {
      partition,
      offlineId: input.offlineId,
      values: input.values,
      deviceSavedAt: this.now(),
      ids: { eventId: this.createId(), idempotencyKey: this.createId() },
    };
    return this.repository.saveVisitPricesAndEnqueue(command);
  }

  async listCommercialActions(userId: string): Promise<CommercialAction[] | null> {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de consultar ações.');
    if (navigator.onLine) {
      try {
        const response = await fetch(commercialActionsPath, {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        });
        if (response.status === 401 || response.status === 403) return null;
        if (response.ok) {
          const catalog = commercialActionListSchema.parse(await response.json());
          if (this.accessRevoked) return null;
          const cachedAt = this.now();
          await this.repository.cacheCommercialActions(partition, catalog, cachedAt);
          return currentCommercialActions(catalog.actions, saoPauloDate(cachedAt));
        }
      } catch { /* Use only the last validated catalog for this partition and day. */ }
    }
    if (this.accessRevoked) return null;
    const cached = await this.repository.getCommercialActions(partition);
    const today = saoPauloDate(this.now());
    if (!cached || saoPauloDate(cached.cachedAt) !== today) return null;
    return currentCommercialActions(cached.actions, today);
  }

  async listScrapPoints(userId: string): Promise<ScrapPoint[]> {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de consultar pontos.');
    if (navigator.onLine) {
      try {
        const response = await fetch(scrapPointsPath, {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const points = scrapPointListSchema.parse(await response.json()).points;
          await this.repository.cacheScrapPoints(partition, points, this.now());
          return points.filter((point) => point.active);
        }
      } catch { /* Keep the last validated list while offline. */ }
    }
    return this.repository.listScrapPoints(partition);
  }

  async saveVisitCommercialActions(input: {
    userId: string;
    offlineId: string;
    values: CommercialActionsInput;
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de editar.');
    const command: SaveVisitCommercialActionsCommand = {
      partition,
      offlineId: input.offlineId,
      values: input.values,
      deviceSavedAt: this.now(),
      ids: { eventId: this.createId(), idempotencyKey: this.createId() },
    };
    return this.repository.saveVisitCommercialActionsAndEnqueue(command);
  }

  async saveVisitScrap(input: {
    userId: string;
    offlineId: string;
    values: VisitScrapInput;
  }) {
    await this.repository.open();
    const partition = { userId: input.userId, deviceId: this.getDeviceId() };
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de editar.');
    const command: SaveVisitScrapCommand = {
      partition,
      offlineId: input.offlineId,
      values: input.values,
      deviceSavedAt: this.now(),
      ids: { eventId: this.createId(), idempotencyKey: this.createId() },
    };
    return this.repository.saveVisitScrapAndEnqueue(command);
  }

  async refresh(partition: OfflinePartition) {
    return this.loadAuthorizedPartition(partition, false);
  }

  async synchronize(partition: OfflinePartition): Promise<OfflineSyncRunSummary> {
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de sincronizar.');
    if (!navigator.onLine) return {
      attempted: 0,
      confirmed: 0,
      recoverable: 0,
      actionRequired: 0,
      authenticationRequired: false,
      evidenceDisabled: false,
      scrapEvidenceDisabled: false,
    };
    const outbox = await this.syncEngine.synchronize(partition);
    const scrap = await this.scrapEvidenceSync.synchronize(partition).catch(() => ({
      attempted: 1, confirmed: 0, recoverable: 1, actionRequired: 0,
      disabled: false, authenticationRequired: false,
    }));
    const evidence = await this.evidenceSync.synchronize(partition).catch(() => ({
      attempted: 1,
      confirmed: 0,
      recoverable: 1,
      actionRequired: 0,
      disabled: false,
      authenticationRequired: false,
    }));
    return {
      attempted: outbox.attempted + scrap.attempted + evidence.attempted,
      confirmed: outbox.confirmed + scrap.confirmed + evidence.confirmed,
      recoverable: outbox.recoverable + scrap.recoverable + evidence.recoverable,
      actionRequired: outbox.actionRequired + scrap.actionRequired + evidence.actionRequired,
      authenticationRequired: outbox.authenticationRequired || scrap.authenticationRequired || evidence.authenticationRequired,
      evidenceDisabled: evidence.disabled,
      scrapEvidenceDisabled: scrap.disabled,
    };
  }

  close() {
    this.repository.close();
  }

  private async invalidateLocalAccess(deviceId: string, ...userIds: Array<string | null>) {
    let storageFailure: unknown;
    const uniqueUserIds = [...new Set(userIds.filter((userId): userId is string => Boolean(userId)))];
    try {
      const currentUserId = window.localStorage.getItem(userStorageKey);
      if (currentUserId && uniqueUserIds.includes(currentUserId)) window.localStorage.removeItem(userStorageKey);
    } catch (error) { storageFailure = error; }
    await Promise.all(uniqueUserIds.map((userId) => (
      this.repository.deleteLocalSession({ userId, deviceId })
    )));
    if (storageFailure) throw storageFailure;
  }

  private getDeviceId() {
    this.currentDeviceId ??= getOrCreateDeviceId();
    return this.currentDeviceId;
  }

  private async requireLocalAccess(partition: OfflinePartition) {
    const denied = { allowed: false as const, reason: 'session_expired' as const };
    if (this.accessRevoked) return denied;
    const session = await this.repository.getLocalSession(partition);
    if (this.accessRevoked || !session) return denied;
    const decision = evaluateLocalAccess(session, partition, this.now());
    if (decision.allowed) await this.repository.saveLocalSession(decision.session);
    if (this.accessRevoked) {
      await this.invalidateLocalAccess(partition.deviceId, partition.userId);
      return denied;
    }
    return decision;
  }

  private async loadAuthorizedPartition(
    partition: OfflinePartition,
    waitForInstall: boolean,
    readiness?: { workerReady: boolean; storagePersisted: boolean },
  ): Promise<OfflineShellResult> {
    const access = await this.requireLocalAccess(partition);
    if (this.accessRevoked) return revokedResult;
    if (!access.allowed) {
      const reason = access.reason === 'clock_rollback' ? 'clock_rollback' : 'session_expired';
      return {
        kind: 'blocked',
        reason,
        message: reason === 'clock_rollback'
          ? 'O relógio do aparelho recuou. Revalide a identidade online para continuar.'
          : 'A janela local de 24 horas expirou. Os pendentes foram preservados; revalide online.',
      };
    }
    await this.repository.purgeExpiredVisitEvidence(partition, this.now());
    const [routes, drafts, outbox, workerReady, storagePersisted] = await Promise.all([
      this.repository.listRouteBundles(partition),
      this.repository.listDrafts(partition),
      this.repository.listOutbox(partition),
      readiness ? Promise.resolve(readiness.workerReady) : workerIsReady(waitForInstall, this.revocationController.signal),
      readiness ? Promise.resolve(readiness.storagePersisted) : storageIsPersisted(),
    ]);
    if (this.accessRevoked) return revokedResult;
    return { kind: 'ready', partition, routes, drafts, outbox, workerReady, storagePersisted };
  }
}
