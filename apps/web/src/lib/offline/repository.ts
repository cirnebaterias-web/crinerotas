import Dexie from 'dexie';
import {
  localSessionSchema,
  localVisitDraftSchema,
  offlineRouteBundleSchema,
  offlineOutboxEventSchema,
  offlinePartitionSchema,
  type LocalSession,
  type LocalVisitDraft,
  type OfflineRouteBundle,
  type OfflineOutboxEvent,
  type OfflinePartition,
  type SyncErrorCode,
  type SyncResult,
} from '@cirne/contracts';
import {
  createDraftMutation,
  createVisitStartMutation,
  createVisitStockMutation,
  orderOutboxEvents,
  type DraftMutationIds,
  type VisitStartMutationIds,
  type VisitStockMutationIds,
} from '@cirne/domain';
import type { OfflineDatabase } from './database';
import { SyncEventPersistenceError } from './sync-persistence-error';

function assertPartition(partition: OfflinePartition, record: { userId: string; deviceId: string }) {
  offlinePartitionSchema.parse({ userId: partition.userId, deviceId: partition.deviceId });
  if (record.userId !== partition.userId || record.deviceId !== partition.deviceId) {
    throw new Error('Registro fora da partição offline solicitada.');
  }
}

export interface SaveDraftCommand {
  partition: OfflinePartition;
  routeVersionStopId: string;
  acknowledged: boolean;
  occurredAt: string;
  ids: DraftMutationIds;
}

export interface SaveVisitStartCommand {
  partition: OfflinePartition;
  routeVersionStopId: string;
  deviceStartedAt: string;
  location?: {
    latitude: string;
    longitude: string;
    accuracyM?: string;
    distanceM?: string;
  };
  ids: VisitStartMutationIds;
}

export interface SaveVisitStockCommand {
  partition: OfflinePartition;
  offlineId: string;
  heliarQuantity: number;
  mouraQuantity: number;
  observation?: string;
  deviceSavedAt: string;
  ids: VisitStockMutationIds;
}

type FailedOutboxStatus = Extract<OfflineOutboxEvent['status'], 'recoverable_error' | 'action_required'>;

export class OfflineRepository {
  constructor(private readonly db: OfflineDatabase) {}

  async open() {
    await this.db.open();
  }

  close() {
    this.db.close();
  }

  async saveValidatedRoute(bundleInput: OfflineRouteBundle, sessionInput: LocalSession) {
    const bundle = offlineRouteBundleSchema.parse(bundleInput);
    const session = localSessionSchema.parse(sessionInput);
    assertPartition(session, bundle);
    return this.db.transaction('rw', this.db.routeBundles, this.db.localSessions, async () => {
      const key: [string, string, string] = [bundle.userId, bundle.deviceId, bundle.routeId];
      const existing = await this.db.routeBundles.get(key);
      if ((existing?.schemaVersion === 2 || existing?.schemaVersion === 3) && (
        bundle.schemaVersion === 1 ||
        existing.versionNumber > bundle.versionNumber ||
        (existing.versionNumber === bundle.versionNumber && existing.executionVersion > bundle.executionVersion) ||
        (existing.versionNumber === bundle.versionNumber &&
          existing.executionVersion === bundle.executionVersion &&
          Date.parse(existing.cachedAt) > Date.parse(bundle.cachedAt))
      )) {
        await this.saveNewestLocalSession(session);
        return existing;
      }
      await this.db.routeBundles.put(bundle);
      await this.saveNewestLocalSession(session);
      return bundle;
    });
  }

  private async saveNewestLocalSession(session: LocalSession) {
    const key: [string, string] = [session.userId, session.deviceId];
    const current = await this.db.localSessions.get(key);
    if (!current || Date.parse(session.validatedAt) > Date.parse(current.validatedAt) || (
      session.validatedAt === current.validatedAt &&
      Date.parse(session.lastObservedAt) >= Date.parse(current.lastObservedAt)
    )) {
      await this.db.localSessions.put(session);
    }
  }

  async getRouteBundle(partitionInput: OfflinePartition, routeId: string) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.routeBundles.get([partition.userId, partition.deviceId, routeId]);
  }

  async listRouteBundles(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.routeBundles.where('[userId+deviceId]').equals([
      partition.userId,
      partition.deviceId,
    ]).toArray();
  }

  async getLocalSession(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.localSessions.get([partition.userId, partition.deviceId]);
  }

  async saveLocalSession(sessionInput: LocalSession) {
    const session = localSessionSchema.parse(sessionInput);
    await this.db.localSessions.put(session);
    return session;
  }

  async deleteLocalSession(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    await this.db.localSessions.delete([partition.userId, partition.deviceId]);
  }

  async listDrafts(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.visitDrafts.where('[userId+deviceId]').equals([
      partition.userId,
      partition.deviceId,
    ]).toArray();
  }

  async getDraft(partitionInput: OfflinePartition, offlineId: string) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.visitDrafts.get([partition.userId, partition.deviceId, offlineId]);
  }

  async findDraftForStop(partitionInput: OfflinePartition, routeVersionStopId: string) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.visitDrafts.where('[userId+deviceId+routeVersionStopId]').equals([
      partition.userId,
      partition.deviceId,
      routeVersionStopId,
    ]).first();
  }

  async listOutbox(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.outboxEvents.where('[userId+deviceId]').equals([
      partition.userId,
      partition.deviceId,
    ]).sortBy('occurredAt');
  }

  async reserveOutboxBatch(
    partitionInput: OfflinePartition,
    now: string,
    leaseUntil: string,
    limit = 25,
  ) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    const nowMs = Date.parse(now);
    const leaseUntilMs = Date.parse(leaseUntil);
    if (!Number.isFinite(nowMs) || !Number.isFinite(leaseUntilMs) || leaseUntilMs <= nowMs) {
      throw new Error('Janela de reserva inválida.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('Limite de reserva inválido.');
    }

    return this.db.transaction('rw', this.db.outboxEvents, async () => {
      const all = orderOutboxEvents(await this.db.outboxEvents.where('[userId+deviceId]').equals([
        partition.userId,
        partition.deviceId,
      ]).toArray());
      const blockedAggregates = new Set<string>();
      const selected: OfflineOutboxEvent[] = [];

      for (const event of all) {
        if (selected.length >= limit) break;
        if (blockedAggregates.has(event.aggregateId)) continue;
        const eligible = event.status === 'pending' ||
          (event.status === 'recoverable_error' && (!event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= nowMs)) ||
          (event.status === 'sending' && Boolean(event.leaseUntil) && Date.parse(event.leaseUntil!) <= nowMs);
        if (!eligible) {
          blockedAggregates.add(event.aggregateId);
          continue;
        }
        const reserved = offlineOutboxEventSchema.parse({
          ...event,
          status: 'sending',
          attemptCount: event.attemptCount + 1,
          leaseUntil,
          nextAttemptAt: undefined,
        });
        await this.db.outboxEvents.put(reserved);
        selected.push(reserved);
      }
      return selected;
    });
  }

  async recordOutboxFailure(
    partitionInput: OfflinePartition,
    eventId: string,
    input: { status: FailedOutboxStatus; code: SyncErrorCode; nextAttemptAt?: string },
  ) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.transaction('rw', this.db.outboxEvents, async () => {
      const key: [string, string, string] = [partition.userId, partition.deviceId, eventId];
      const current = await this.db.outboxEvents.get(key);
      if (!current) return undefined;
      const updated = offlineOutboxEventSchema.parse({
        ...current,
        status: input.status,
        lastErrorCode: input.code,
        nextAttemptAt: input.nextAttemptAt,
        leaseUntil: undefined,
      });
      await this.db.outboxEvents.put(updated);
      return updated;
    });
  }

  async applySyncConfirmation(
    partitionInput: OfflinePartition,
    confirmationInput: SyncResult,
  ) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    if (confirmationInput.status !== 'confirmed') {
      throw new Error('Somente confirmação canônica pode concluir um evento local.');
    }
    return this.db.transaction('rw', this.db.visitDrafts, this.db.outboxEvents, async () => {
      const key: [string, string, string] = [partition.userId, partition.deviceId, confirmationInput.eventId];
      const event = await this.db.outboxEvents.get(key);
      if (!event) return false;
      assertPartition(partition, event);
      if (event.operation === 'visit.draft.saved' && confirmationInput.canonicalId !== event.aggregateId) {
        throw new SyncEventPersistenceError('Confirmação canônica não corresponde ao agregado local.');
      }
      const draftKey: [string, string, string] = [partition.userId, partition.deviceId, event.aggregateId];
      const draft = await this.db.visitDrafts.get(draftKey);
      if (!draft) throw new SyncEventPersistenceError('Confirmação sem rascunho local correspondente.');
      if (event.operation !== 'visit.draft.saved' && draft.canonicalVisitId &&
          confirmationInput.canonicalId !== draft.canonicalVisitId) {
        throw new SyncEventPersistenceError('Confirmação canônica não corresponde à visita local.');
      }

      await this.db.outboxEvents.delete(key);
      const remaining = await this.db.outboxEvents
        .where('[userId+deviceId+aggregateId+sequence]')
        .between(
          [partition.userId, partition.deviceId, event.aggregateId, Dexie.minKey],
          [partition.userId, partition.deviceId, event.aggregateId, Dexie.maxKey],
        )
        .count();
      // Preserve the start's canonical identity even while later changes are still queued.
      if (remaining === 0 || event.operation === 'visit.started.v1') {
        await this.db.visitDrafts.put(localVisitDraftSchema.parse({
          ...draft,
          ...(event.operation === 'visit.started.v1' ? {
            canonicalVisitId: confirmationInput.canonicalId,
            serverStartedAt: confirmationInput.confirmedAt,
          } : {}),
          ...(event.operation === 'visit.stock.saved.v1' && draft.stock?.eventId === event.eventId ? {
            stock: {
              ...draft.stock,
              persistenceState: 'synced' as const,
              serverSavedAt: confirmationInput.confirmedAt,
            },
          } : {}),
          lastConfirmedSequence: Math.max(draft.lastConfirmedSequence ?? 0, event.sequence),
          persistenceState: remaining === 0 ? 'synced' : draft.persistenceState,
          updatedAt: remaining === 0 ? confirmationInput.confirmedAt : draft.updatedAt,
        }));
      }
      return true;
    });
  }

  async saveDraftAndEnqueue(command: SaveDraftCommand): Promise<{
    draft: LocalVisitDraft;
    event: OfflineOutboxEvent;
    repeated: boolean;
  }> {
    const partition = offlinePartitionSchema.parse(command.partition);
    return this.db.transaction(
      'rw',
      this.db.routeBundles,
      this.db.visitDrafts,
      this.db.outboxEvents,
      async () => {
        const existing = await this.db.outboxEvents.get([
          partition.userId,
          partition.deviceId,
          command.ids.eventId,
        ]);
        if (existing) {
          if (existing.idempotencyKey !== command.ids.idempotencyKey ||
              existing.aggregateId !== command.ids.draftOfflineId ||
              existing.operation !== 'visit.draft.saved' ||
              existing.payload.routeVersionStopId !== command.routeVersionStopId ||
              existing.payload.acknowledged !== command.acknowledged) {
            throw new Error('Evento repetido com conteúdo divergente.');
          }
          const currentDraft = await this.db.visitDrafts.get([
            partition.userId,
            partition.deviceId,
            command.ids.draftOfflineId,
          ]);
          if (!currentDraft) throw new Error('Evento sem rascunho correspondente.');
          return { draft: currentDraft, event: existing, repeated: true };
        }

        const idempotencyCollision = await this.db.outboxEvents
          .where('[userId+deviceId+idempotencyKey]')
          .equals([partition.userId, partition.deviceId, command.ids.idempotencyKey])
          .first();
        if (idempotencyCollision) throw new Error('Chave idempotente já utilizada por outro evento.');

        const bundles = await this.db.routeBundles.where('[userId+deviceId]').equals([
          partition.userId,
          partition.deviceId,
        ]).toArray();
        const stopExists = bundles.some((bundle) => bundle.stops.some(
          (stop) => stop.routeVersionStopId === command.routeVersionStopId,
        ));
        if (!stopExists) throw new Error('Parada indisponível nesta partição offline.');

        const previous = await this.db.outboxEvents
          .where('[userId+deviceId+aggregateId+sequence]')
          .between(
            [partition.userId, partition.deviceId, command.ids.draftOfflineId, Dexie.minKey],
            [partition.userId, partition.deviceId, command.ids.draftOfflineId, Dexie.maxKey],
          )
          .last();
        const mutation = createDraftMutation({
          ...command,
          partition,
          sequence: (previous?.sequence ?? 0) + 1,
        });
        const draft = localVisitDraftSchema.parse(mutation.draft);
        const event = offlineOutboxEventSchema.parse(mutation.event);
        assertPartition(partition, draft);
        assertPartition(partition, event);
        await this.db.visitDrafts.put(draft);
        await this.db.outboxEvents.add(event);
        return { draft, event, repeated: false };
      },
    );
  }

  async saveVisitStartAndEnqueue(command: SaveVisitStartCommand): Promise<{
    draft: LocalVisitDraft;
    event?: OfflineOutboxEvent;
    reopened: boolean;
  }> {
    const partition = offlinePartitionSchema.parse(command.partition);
    return this.db.transaction(
      'rw',
      this.db.routeBundles,
      this.db.visitDrafts,
      this.db.outboxEvents,
      async () => {
        const existingDraft = await this.db.visitDrafts
          .where('[userId+deviceId+routeVersionStopId]')
          .equals([partition.userId, partition.deviceId, command.routeVersionStopId])
          .first();
        if (existingDraft?.deviceStartedAt) {
          const event = await this.db.outboxEvents
            .where('[userId+deviceId+aggregateId+sequence]')
            .between(
              [partition.userId, partition.deviceId, existingDraft.offlineId, Dexie.minKey],
              [partition.userId, partition.deviceId, existingDraft.offlineId, Dexie.maxKey],
            ).first();
          return { draft: existingDraft, event, reopened: true };
        }

        const eventCollision = await this.db.outboxEvents.get([
          partition.userId,
          partition.deviceId,
          command.ids.eventId,
        ]);
        const keyCollision = await this.db.outboxEvents
          .where('[userId+deviceId+idempotencyKey]')
          .equals([partition.userId, partition.deviceId, command.ids.idempotencyKey])
          .first();
        if (eventCollision || keyCollision) {
          throw new Error('Identificador de evento local já utilizado.');
        }

        const bundles = await this.db.routeBundles.where('[userId+deviceId]').equals([
          partition.userId,
          partition.deviceId,
        ]).toArray();
        const canonicalBundle = bundles.find((bundle) =>
          (bundle.schemaVersion === 2 || bundle.schemaVersion === 3) &&
          bundle.stops.some((stop) => stop.routeVersionStopId === command.routeVersionStopId));
        if (!canonicalBundle || (canonicalBundle.schemaVersion !== 2 && canonicalBundle.schemaVersion !== 3)) {
          throw new Error('Parada indisponível nesta partição offline.');
        }
        const stop = canonicalBundle.stops.find(
          (candidate) => candidate.routeVersionStopId === command.routeVersionStopId,
        );
        if (!stop || stop.status !== 'pending') {
          throw new Error('A parada não está pendente para iniciar a visita.');
        }

        const offlineId = existingDraft?.offlineId ?? command.ids.offlineId;
        const lastPending = await this.db.outboxEvents
          .where('[userId+deviceId+aggregateId+sequence]')
          .between(
            [partition.userId, partition.deviceId, offlineId, Dexie.minKey],
            [partition.userId, partition.deviceId, offlineId, Dexie.maxKey],
          ).last();
        const mutation = createVisitStartMutation({
          partition,
          routeVersionStopId: command.routeVersionStopId,
          deviceStartedAt: command.deviceStartedAt,
          client: stop.client,
          ...(command.location ? { location: command.location } : {}),
          sequence: Math.max(lastPending?.sequence ?? 0, existingDraft?.lastConfirmedSequence ?? 0) + 1,
          ids: { ...command.ids, offlineId },
        });
        const draft = localVisitDraftSchema.parse({ ...existingDraft, ...mutation.draft });
        assertPartition(partition, mutation.draft);
        assertPartition(partition, mutation.event);
        if (existingDraft) await this.db.visitDrafts.put(draft);
        else await this.db.visitDrafts.add(draft);
        await this.db.outboxEvents.add(mutation.event);
        return { draft, event: mutation.event, reopened: false };
      },
    );
  }

  async saveVisitStockAndEnqueue(command: SaveVisitStockCommand): Promise<{
    draft: LocalVisitDraft;
    event: OfflineOutboxEvent;
  }> {
    const partition = offlinePartitionSchema.parse(command.partition);
    return this.db.transaction('rw', this.db.visitDrafts, this.db.outboxEvents, async () => {
      const draftKey: [string, string, string] = [partition.userId, partition.deviceId, command.offlineId];
      const currentDraft = await this.db.visitDrafts.get(draftKey);
      if (!currentDraft) throw new Error('Visita não encontrada nesta partição offline.');
      assertPartition(partition, currentDraft);

      const eventCollision = await this.db.outboxEvents.get([
        partition.userId, partition.deviceId, command.ids.eventId,
      ]);
      const keyCollision = await this.db.outboxEvents
        .where('[userId+deviceId+idempotencyKey]')
        .equals([partition.userId, partition.deviceId, command.ids.idempotencyKey])
        .first();
      if (eventCollision || keyCollision) throw new Error('Identificador de evento local já utilizado.');

      const lastPending = await this.db.outboxEvents
        .where('[userId+deviceId+aggregateId+sequence]')
        .between(
          [partition.userId, partition.deviceId, command.offlineId, Dexie.minKey],
          [partition.userId, partition.deviceId, command.offlineId, Dexie.maxKey],
        ).last();
      const sequence = Math.max(lastPending?.sequence ?? 0, currentDraft.lastConfirmedSequence ?? 0) + 1;
      const mutation = createVisitStockMutation({
        draft: currentDraft,
        values: {
          heliarQuantity: command.heliarQuantity,
          mouraQuantity: command.mouraQuantity,
          ...(command.observation === undefined ? {} : { observation: command.observation }),
        },
        deviceSavedAt: command.deviceSavedAt,
        sequence,
        ids: command.ids,
      });
      await this.db.visitDrafts.put(mutation.draft);
      await this.db.outboxEvents.add(mutation.event);
      return mutation;
    });
  }
}
