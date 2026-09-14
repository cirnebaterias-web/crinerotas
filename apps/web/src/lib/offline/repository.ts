import Dexie from 'dexie';
import {
  localRouteBundleSchema,
  localSessionSchema,
  localVisitDraftSchema,
  offlineOutboxEventSchema,
  offlinePartitionSchema,
  type LocalRouteBundle,
  type LocalSession,
  type LocalVisitDraft,
  type OfflineOutboxEvent,
  type OfflinePartition,
} from '@cirne/contracts';
import { createDraftMutation, type DraftMutationIds } from '@cirne/domain';
import type { OfflineDatabase } from './database';

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

export class OfflineRepository {
  constructor(private readonly db: OfflineDatabase) {}

  async open() {
    await this.db.open();
  }

  close() {
    this.db.close();
  }

  async saveValidatedRoute(bundleInput: LocalRouteBundle, sessionInput: LocalSession) {
    const bundle = localRouteBundleSchema.parse(bundleInput);
    const session = localSessionSchema.parse(sessionInput);
    assertPartition(session, bundle);
    return this.db.transaction('rw', this.db.routeBundles, this.db.localSessions, async () => {
      await this.db.routeBundles.put(bundle);
      await this.db.localSessions.put(session);
      return bundle;
    });
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

  async listOutbox(partitionInput: OfflinePartition) {
    const partition = offlinePartitionSchema.parse(partitionInput);
    return this.db.outboxEvents.where('[userId+deviceId]').equals([
      partition.userId,
      partition.deviceId,
    ]).sortBy('occurredAt');
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
}
