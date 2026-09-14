import {
  localRouteBundleSchema,
  localSessionSchema,
  localVisitDraftSchema,
  offlineOutboxEventSchema,
  type LocalRouteBundle,
  type LocalSession,
  type LocalVisitDraft,
  type OfflineOutboxEvent,
  type OfflinePartition,
} from '@cirne/contracts';

export const localAccessWindowMs = 24 * 60 * 60 * 1_000;

export type LocalAccessDecision =
  | { allowed: true; session: LocalSession }
  | { allowed: false; reason: 'identity_mismatch' | 'session_expired' | 'clock_rollback' };

export function createValidatedLocalSession(
  partition: OfflinePartition,
  validatedAt: string,
): LocalSession {
  const timestamp = Date.parse(validatedAt);
  if (!Number.isFinite(timestamp)) throw new Error('Horário de validação inválido.');
  return localSessionSchema.parse({
    schemaVersion: 1,
    ...partition,
    validatedAt,
    validUntil: new Date(timestamp + localAccessWindowMs).toISOString(),
    lastObservedAt: validatedAt,
  });
}

export function evaluateLocalAccess(
  session: LocalSession,
  partition: OfflinePartition,
  now: string,
): LocalAccessDecision {
  if (session.userId !== partition.userId || session.deviceId !== partition.deviceId) {
    return { allowed: false, reason: 'identity_mismatch' };
  }
  const nowMs = Date.parse(now);
  const validatedAtMs = Date.parse(session.validatedAt);
  const lastObservedAtMs = Date.parse(session.lastObservedAt);
  const validUntilMs = Date.parse(session.validUntil);
  if (![nowMs, validatedAtMs, lastObservedAtMs, validUntilMs].every(Number.isFinite)) {
    return { allowed: false, reason: 'session_expired' };
  }
  if (nowMs < validatedAtMs || nowMs < lastObservedAtMs) {
    return { allowed: false, reason: 'clock_rollback' };
  }
  if (nowMs > validUntilMs) return { allowed: false, reason: 'session_expired' };
  return {
    allowed: true,
    session: localSessionSchema.parse({ ...session, lastObservedAt: now }),
  };
}

export interface DraftMutationIds {
  draftOfflineId: string;
  eventId: string;
  idempotencyKey: string;
}

export function createDraftMutation(input: {
  partition: OfflinePartition;
  routeVersionStopId: string;
  acknowledged: boolean;
  sequence: number;
  occurredAt: string;
  ids: DraftMutationIds;
}): { draft: LocalVisitDraft; event: OfflineOutboxEvent } {
  const { partition, routeVersionStopId, acknowledged, sequence, occurredAt, ids } = input;
  const draft = localVisitDraftSchema.parse({
    schemaVersion: 1,
    ...partition,
    offlineId: ids.draftOfflineId,
    routeVersionStopId,
    currentStep: 'start',
    acknowledged,
    localStatus: 'draft',
    persistenceState: 'saved_on_device',
    updatedAt: occurredAt,
  });
  const event = offlineOutboxEventSchema.parse({
    schemaVersion: 1,
    ...partition,
    eventId: ids.eventId,
    idempotencyKey: ids.idempotencyKey,
    operation: 'visit.draft.saved',
    aggregateId: ids.draftOfflineId,
    sequence,
    payload: { draftOfflineId: ids.draftOfflineId, routeVersionStopId, acknowledged },
    status: 'pending',
    attemptCount: 0,
    occurredAt,
  });
  return {
    draft,
    event,
  };
}

export const syntheticRouteIds = {
  routeId: '33333333-3333-4333-8333-333333333333',
  firstStopId: '44444444-4444-4444-8444-444444444441',
  secondStopId: '44444444-4444-4444-8444-444444444442',
} as const;

export function createSyntheticRouteBundle(
  partition: OfflinePartition,
  cachedAt: string,
): LocalRouteBundle {
  return localRouteBundleSchema.parse({
    schemaVersion: 1,
    ...partition,
    routeId: syntheticRouteIds.routeId,
    routeVersion: 1,
    parameterSetVersion: 1,
    serviceDate: '2026-09-11',
    stops: [
      { routeVersionStopId: syntheticRouteIds.firstStopId, displayLabel: 'Parada sintética 01', executionOrder: 1, priority: 1 },
      { routeVersionStopId: syntheticRouteIds.secondStopId, displayLabel: 'Parada sintética 02', executionOrder: 2, priority: 0 },
    ],
    cachedAt,
  });
}
