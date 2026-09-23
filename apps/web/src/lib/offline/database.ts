import Dexie, { type DexieOptions, type Table } from 'dexie';
import type {
  LocalSession,
  LocalVisitDraft,
  LocalCompetitorPriceParameterSet,
  OfflineRouteBundle,
  OfflineOutboxEvent,
} from '@cirne/contracts';

export const offlineDatabaseVersion = 9;

export const offlineV1Stores = {
  routeBundles: '&[userId+deviceId+routeId], [userId+deviceId], userId, deviceId, cachedAt',
  visitDrafts: '&[userId+deviceId+offlineId], [userId+deviceId], [userId+deviceId+routeVersionStopId], updatedAt',
  outboxEvents: '&[userId+deviceId+eventId], &[userId+deviceId+idempotencyKey], &[userId+deviceId+aggregateId+sequence], [userId+deviceId], status, occurredAt',
} as const;

export const offlineV2Stores = {
  ...offlineV1Stores,
  localSessions: '&[userId+deviceId], userId, deviceId, validUntil',
} as const;

export const offlineV3Stores = {
  ...offlineV2Stores,
  outboxEvents: '&[userId+deviceId+eventId], &[userId+deviceId+idempotencyKey], &[userId+deviceId+aggregateId+sequence], [userId+deviceId], [userId+deviceId+status], status, nextAttemptAt, leaseUntil, occurredAt',
} as const;

export const offlineV4Stores = {
  ...offlineV3Stores,
} as const;

export const offlineV5Stores = {
  ...offlineV4Stores,
} as const;

export const offlineV6Stores = {
  ...offlineV5Stores,
} as const;

export const offlineV7Stores = {
  ...offlineV6Stores,
} as const;

export const offlineV8Stores = {
  ...offlineV7Stores,
  outboxEvents: '&[userId+deviceId+eventId], &[userId+deviceId+idempotencyKey], &[userId+deviceId+aggregateType+aggregateId+sequence], [userId+deviceId+aggregateId+sequence], [userId+deviceId], [userId+deviceId+status], status, nextAttemptAt, leaseUntil, occurredAt',
} as const;

export const offlineV9Stores = {
  ...offlineV8Stores,
  priceParameterSets: '&[userId+deviceId+parameterSetId], [userId+deviceId], validFrom, cachedAt',
} as const;

export class OfflineDatabase extends Dexie {
  routeBundles!: Table<OfflineRouteBundle, [string, string, string]>;
  visitDrafts!: Table<LocalVisitDraft, [string, string, string]>;
  outboxEvents!: Table<OfflineOutboxEvent, [string, string, string]>;
  localSessions!: Table<LocalSession, [string, string]>;
  priceParameterSets!: Table<LocalCompetitorPriceParameterSet, [string, string, string]>;

  constructor(name = 'cirne-rotas-offline', options?: DexieOptions) {
    super(name, options);
    this.version(1).stores(offlineV1Stores);
    this.version(2).stores(offlineV2Stores);
    this.version(3).stores(offlineV3Stores);
    this.version(4).stores(offlineV4Stores);
    this.version(5).stores(offlineV5Stores);
    this.version(6).stores(offlineV6Stores);
    this.version(7).stores(offlineV7Stores);
    this.version(8).stores(offlineV8Stores).upgrade(async (transaction) => {
      // The namespace is already part of the wire contract. Preserve event identities and payloads.
      await transaction.table('outboxEvents').toCollection().modify((event) => {
        event.aggregateType = event.operation === 'visit.draft.saved' ? 'visit_draft' : 'visit';
      });
    });
    this.version(offlineDatabaseVersion).stores(offlineV9Stores);
  }
}
