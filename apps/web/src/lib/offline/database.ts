import Dexie, { type DexieOptions, type Table } from 'dexie';
import type {
  LocalRouteBundle,
  LocalSession,
  LocalVisitDraft,
  OfflineOutboxEvent,
} from '@cirne/contracts';

export const offlineDatabaseVersion = 3;

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

export class OfflineDatabase extends Dexie {
  routeBundles!: Table<LocalRouteBundle, [string, string, string]>;
  visitDrafts!: Table<LocalVisitDraft, [string, string, string]>;
  outboxEvents!: Table<OfflineOutboxEvent, [string, string, string]>;
  localSessions!: Table<LocalSession, [string, string]>;

  constructor(name = 'cirne-rotas-offline', options?: DexieOptions) {
    super(name, options);
    this.version(1).stores(offlineV1Stores);
    this.version(2).stores(offlineV2Stores);
    this.version(offlineDatabaseVersion).stores(offlineV3Stores);
  }
}
