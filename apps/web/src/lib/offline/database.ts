import Dexie, { type DexieOptions, type Table } from 'dexie';
import type {
  LocalSession,
  LocalVisitDraft,
  LocalCompetitorPriceParameterSet,
  OfflineRouteBundle,
  OfflineOutboxEvent,
  LocalAttachment,
  LocalVisitEvidence,
  ScrapClient,
  CreatePickupScheduleRequest,
  ScrapPoint,
  CommercialActionList,
} from '@cirne/contracts';

export const offlineDatabaseVersion = 14;

export interface LocalCommercialActionCatalog extends CommercialActionList {
  userId: string;
  deviceId: string;
  cachedAt: string;
}

export interface LocalScrapPoint extends ScrapPoint {
  userId: string;
  deviceId: string;
  cachedAt: string;
}

export interface LocalScrapClient extends ScrapClient {
  userId: string;
  deviceId: string;
  cachedAt: string;
}

export interface LocalStandaloneScrapSchedule {
  userId: string;
  deviceId: string;
  offlineId: string;
  client: ScrapClient;
  request: CreatePickupScheduleRequest;
  idempotencyKey: string;
  status: 'pending' | 'synced' | 'action_required';
  createdAt: string;
  lastError?: string;
  serverId?: string;
  serverSavedAt?: string;
}

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

export const offlineV10Stores = {
  ...offlineV9Stores,
  attachments: '&[userId+deviceId+offlineId], [userId+deviceId+visitOfflineId], [userId+deviceId], visitOfflineId, status, capturedAt',
} as const;

export const offlineV11Stores = {
  ...offlineV10Stores,
  visitEvidence: '&[userId+deviceId+offlineId], &[userId+deviceId+visitOfflineId+kind], [userId+deviceId+visitOfflineId], expiresAt, status',
} as const;

export const offlineV12Stores = {
  ...offlineV11Stores,
  scrapClients: '&[userId+deviceId+id], [userId+deviceId], name, cachedAt',
  scrapSchedules: '&[userId+deviceId+offlineId], [userId+deviceId], status, createdAt',
} as const;

export const offlineV13Stores = {
  ...offlineV12Stores,
  scrapPoints: '&[userId+deviceId+id], [userId+deviceId], active, cachedAt',
} as const;

export const offlineV14Stores = {
  ...offlineV13Stores,
  commercialActionCatalogs: '&[userId+deviceId], cachedAt',
} as const;

export class OfflineDatabase extends Dexie {
  routeBundles!: Table<OfflineRouteBundle, [string, string, string]>;
  visitDrafts!: Table<LocalVisitDraft, [string, string, string]>;
  outboxEvents!: Table<OfflineOutboxEvent, [string, string, string]>;
  localSessions!: Table<LocalSession, [string, string]>;
  priceParameterSets!: Table<LocalCompetitorPriceParameterSet, [string, string, string]>;
  attachments!: Table<LocalAttachment, [string, string, string]>;
  visitEvidence!: Table<LocalVisitEvidence, [string, string, string]>;
  scrapClients!: Table<LocalScrapClient, [string, string, string]>;
  scrapSchedules!: Table<LocalStandaloneScrapSchedule, [string, string, string]>;
  scrapPoints!: Table<LocalScrapPoint, [string, string, string]>;
  commercialActionCatalogs!: Table<LocalCommercialActionCatalog, [string, string]>;

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
    this.version(9).stores(offlineV9Stores);
    this.version(10).stores(offlineV10Stores);
    this.version(11).stores(offlineV11Stores);
    this.version(12).stores(offlineV12Stores);
    this.version(13).stores(offlineV13Stores);
    this.version(offlineDatabaseVersion).stores(offlineV14Stores);
  }
}
