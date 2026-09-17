'use client';

import {
  mePath,
  meResponseSchema,
  type CanonicalLocalRouteBundle,
  type CanonicalRoute,
  type LocalRouteBundle,
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
import { OfflineRepository, type SaveDraftCommand } from './repository';
import { SyncEngine, type RefreshSession, type SyncRunSummary } from './sync-engine';
import { FetchSyncTransport } from './sync-transport';
import {
  isCurrentOfflineRevisionResponse,
  offlineRevisionRequestType,
} from './cache-policy';

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

export interface CanonicalRouteCacheResult {
  bundle: CanonicalLocalRouteBundle;
  workerReady: boolean;
  storagePersisted: boolean;
  availableOffline: boolean;
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

async function workerIsReady(waitForInstall: boolean) {
  if (!('serviceWorker' in navigator)) return false;
  const expectedRevision = process.env.NEXT_PUBLIC_OFFLINE_REVISION;
  if (!expectedRevision) return false;

  const registration = waitForInstall
    ? await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 10_000)),
      ])
    : await navigator.serviceWorker.getRegistration();
  const worker = registration?.active;
  if (!worker) return false;

  return new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => resolve(false), 2_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      resolve(isCurrentOfflineRevisionResponse(event.data, expectedRevision));
    };
    worker.postMessage({ type: offlineRevisionRequestType }, [channel.port2]);
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

export class OfflineFoundationService {
  private readonly repository: OfflineRepository;
  private readonly syncEngine: SyncEngine;
  private currentDeviceId: string | null = null;
  private revocationBarrier: Promise<void> | null = null;
  private accessRevoked = false;

  constructor(
    database = new OfflineDatabase(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    refreshSession: RefreshSession = refreshBrowserSession,
  ) {
    this.repository = new OfflineRepository(database);
    this.syncEngine = new SyncEngine(this.repository, new FetchSyncTransport(), refreshSession);
  }

  async initialize(): Promise<OfflineShellResult> {
    await this.repository.open();
    const deviceId = this.getDeviceId();
    const previousUserId = window.localStorage.getItem(userStorageKey);

    if (navigator.onLine) {
      try {
        const response = await fetch(mePath, { credentials: 'same-origin', cache: 'no-store' });
        if (response.ok) {
          const identity = meResponseSchema.parse(await response.json());
          if (!identity.roles.includes('seller') || identity.status !== 'active') {
            await this.invalidateLocalAccess(deviceId, previousUserId, identity.id);
            return { kind: 'blocked', reason: 'authentication_required', message: 'Acesso de vendedor ativo necessário.' };
          }
          const partition = { userId: identity.id, deviceId };
          if (previousUserId && previousUserId !== identity.id) {
            await this.invalidateLocalAccess(deviceId, previousUserId);
          }
          await this.repository.saveLocalSession(createValidatedLocalSession(partition, this.now()));
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
    return this.persistCanonicalRoute(userId, route);
  }

  private async persistCanonicalRoute(userId: string, route: CanonicalRoute): Promise<CanonicalRouteCacheResult> {
    await this.repository.open();
    const partition = { userId, deviceId: this.getDeviceId() };
    const timestamp = this.now();
    const bundle = createCanonicalLocalRouteBundle(partition, route, timestamp);
    const session = createValidatedLocalSession(partition, timestamp);
    const [workerReady, storagePersisted] = await Promise.all([
      workerIsReady(true),
      requestStoragePersistence(),
    ]);
    if (this.accessRevoked) throw new Error('O acesso local foi revogado.');
    const stored = await this.repository.saveValidatedRoute(bundle, session);
    if (stored.schemaVersion !== 2) throw new Error('O snapshot canônico não foi persistido.');
    window.localStorage.setItem(userStorageKey, userId);
    return { bundle: stored, workerReady, storagePersisted, availableOffline: workerReady };
  }

  revokeLocalAccess(userId?: string) {
    if (this.revocationBarrier) return this.revocationBarrier;
    this.accessRevoked = true;
    const operation = this.performLocalRevocation(userId).finally(() => {
      if (this.revocationBarrier === operation) this.revocationBarrier = null;
    });
    this.revocationBarrier = operation;
    return operation;
  }

  private async performLocalRevocation(userId?: string) {
    await this.repository.open();
    const deviceId = this.getDeviceId();
    let previousUserId: string | null = null;
    try { previousUserId = window.localStorage.getItem(userStorageKey); } catch { /* The explicit user still allows fail-closed session deletion. */ }
    await this.invalidateLocalAccess(deviceId, previousUserId, userId ?? null);
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

  async refresh(partition: OfflinePartition) {
    return this.loadAuthorizedPartition(partition, false);
  }

  async synchronize(partition: OfflinePartition): Promise<SyncRunSummary> {
    const access = await this.requireLocalAccess(partition);
    if (!access.allowed) throw new Error('A sessão local precisa ser revalidada antes de sincronizar.');
    if (!navigator.onLine) return {
      attempted: 0,
      confirmed: 0,
      recoverable: 0,
      actionRequired: 0,
      authenticationRequired: false,
    };
    return this.syncEngine.synchronize(partition);
  }

  close() {
    this.repository.close();
  }

  private async invalidateLocalAccess(deviceId: string, ...userIds: Array<string | null>) {
    let storageFailure: unknown;
    try { window.localStorage.removeItem(userStorageKey); } catch (error) { storageFailure = error; }
    const uniqueUserIds = [...new Set(userIds.filter((userId): userId is string => Boolean(userId)))];
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
    const session = await this.repository.getLocalSession(partition);
    if (!session) return { allowed: false as const, reason: 'session_expired' as const };
    const decision = evaluateLocalAccess(session, partition, this.now());
    if (decision.allowed) await this.repository.saveLocalSession(decision.session);
    return decision;
  }

  private async loadAuthorizedPartition(
    partition: OfflinePartition,
    waitForInstall: boolean,
    readiness?: { workerReady: boolean; storagePersisted: boolean },
  ): Promise<OfflineShellResult> {
    const access = await this.requireLocalAccess(partition);
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
    const [routes, drafts, outbox, workerReady, storagePersisted] = await Promise.all([
      this.repository.listRouteBundles(partition),
      this.repository.listDrafts(partition),
      this.repository.listOutbox(partition),
      readiness ? Promise.resolve(readiness.workerReady) : workerIsReady(waitForInstall),
      readiness ? Promise.resolve(readiness.storagePersisted) : storageIsPersisted(),
    ]);
    return { kind: 'ready', partition, routes, drafts, outbox, workerReady, storagePersisted };
  }
}
