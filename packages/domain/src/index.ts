export { buildGoogleMapsUrl, type NavigationDestination } from './navigation';

import {
  canonicalLocalRouteBundleSchema,
  canonicalRouteSchema,
  createRouteDraftRequestSchema,
  maxSyncBatchEvents,
  localRouteBundleSchema,
  localSessionSchema,
  localVisitDraftSchema,
  offlineOutboxEventSchema,
  type LocalRouteBundle,
  type CanonicalLocalRouteBundle,
  type LocalSession,
  type LocalVisitDraft,
  type OfflineOutboxEvent,
  type OfflinePartition,
  type CanonicalRoute,
  type CreateRouteDraftRequest,
  routeTodayResponseSchema,
  reorderRouteExecutionRequestSchema,
  type ReorderRouteExecutionRequest,
  syncCommandSchema,
  type SyncCommand,
  type SyncErrorCode,
} from '@cirne/contracts';

export class RouteDomainError extends Error {
  constructor(public readonly code: 'VALIDATION_FAILED' | 'VERSION_CONFLICT', message: string) {
    super(message);
  }
}

export function normalizeRouteDraft(input: CreateRouteDraftRequest): CreateRouteDraftRequest {
  const parsed = createRouteDraftRequestSchema.safeParse(input);
  if (!parsed.success) throw new RouteDomainError('VALIDATION_FAILED', 'Rota em rascunho inválida.');
  return {
    ...parsed.data,
    stops: [...parsed.data.stops].sort((left, right) => left.plannedOrder - right.plannedOrder),
  };
}

export function assertExpectedRouteVersion(currentVersion: number, expectedVersion: number) {
  if (!Number.isInteger(currentVersion) || currentVersion < 1 ||
      !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new RouteDomainError('VALIDATION_FAILED', 'Versão de rota inválida.');
  }
  if (currentVersion !== expectedVersion) {
    throw new RouteDomainError('VERSION_CONFLICT', 'A versão enviada conflita com o servidor.');
  }
}

export function normalizePendingStopOrder(
  input: ReorderRouteExecutionRequest,
): ReorderRouteExecutionRequest {
  const parsed = reorderRouteExecutionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new RouteDomainError('VALIDATION_FAILED', 'Ordem de execução inválida.');
  }
  return {
    ...parsed.data,
    pendingStopIds: [...parsed.data.pendingStopIds],
  };
}

export function toRouteTodayResponse(route: CanonicalRoute | null, serviceDate: string) {
  if (route === null) {
    return routeTodayResponseSchema.parse({ schemaVersion: 2, availability: 'empty', serviceDate });
  }
  const parsedRoute = canonicalRouteSchema.parse(route);
  if (parsedRoute.serviceDate !== serviceDate) {
    throw new RouteDomainError('VALIDATION_FAILED', 'A rota não corresponde à data solicitada.');
  }
  return routeTodayResponseSchema.parse({ schemaVersion: 2, availability: 'available', route: parsedRoute });
}

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

export const syntheticClientIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
] as const;

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

export function createCanonicalLocalRouteBundle(
  partition: OfflinePartition,
  routeInput: CanonicalRoute,
  cachedAt: string,
): CanonicalLocalRouteBundle {
  const route = canonicalRouteSchema.parse(routeInput);
  if (route.seller.id !== partition.userId) {
    throw new RouteDomainError('VALIDATION_FAILED', 'A rota não pertence à partição offline informada.');
  }
  return canonicalLocalRouteBundleSchema.parse({
    ...partition,
    ...route,
    cachedAt,
  });
}

export function restoreCanonicalRoute(bundleInput: CanonicalLocalRouteBundle): CanonicalRoute {
  const bundle = canonicalLocalRouteBundleSchema.parse(bundleInput);
  return canonicalRouteSchema.parse({
    schemaVersion: 2,
    routeId: bundle.routeId,
    routeVersionId: bundle.routeVersionId,
    versionNumber: bundle.versionNumber,
    serviceDate: bundle.serviceDate,
    status: bundle.status,
    publishedAt: bundle.publishedAt,
    executionVersion: bundle.executionVersion,
    seller: bundle.seller,
    stops: bundle.stops,
  });
}

export function toSyncCommand(eventInput: OfflineOutboxEvent): SyncCommand {
  const event = offlineOutboxEventSchema.parse(eventInput);
  return syncCommandSchema.parse({
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    operation: event.operation,
    schemaVersion: event.schemaVersion,
    sequence: event.sequence,
    aggregateType: 'visit_draft',
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`).join(',')}}`;
  }
  throw new Error('Valor incompatível com JSON canônico.');
}

export function canonicalizeSyncCommand(commandInput: SyncCommand) {
  const command = syncCommandSchema.parse(commandInput);
  return canonicalJsonValue({
    operation: command.operation,
    schemaVersion: command.schemaVersion,
    aggregateType: command.aggregateType,
    aggregateId: command.aggregateId,
    sequence: command.sequence,
    occurredAt: command.occurredAt,
    payload: command.payload,
  });
}

export async function hashSyncCommand(command: SyncCommand) {
  const bytes = new TextEncoder().encode(canonicalizeSyncCommand(command));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function orderOutboxEvents(events: readonly OfflineOutboxEvent[]) {
  return events.map((event) => offlineOutboxEventSchema.parse(event)).sort((left, right) =>
    left.aggregateId.localeCompare(right.aggregateId) ||
    left.sequence - right.sequence ||
    left.occurredAt.localeCompare(right.occurredAt));
}

export function createSyncBatches(events: readonly OfflineOutboxEvent[]) {
  const ordered = orderOutboxEvents(events);
  const batches: OfflineOutboxEvent[][] = [];
  for (let index = 0; index < ordered.length; index += maxSyncBatchEvents) {
    batches.push(ordered.slice(index, index + maxSyncBatchEvents));
  }
  return batches;
}

export type SyncFailureClass = 'recoverable' | 'authentication_required' | 'dependency' | 'action_required';

export function classifySyncFailure(status: number, code?: SyncErrorCode): SyncFailureClass {
  if (status === 401 || code === 'AUTH_REQUIRED') return 'authentication_required';
  if (code === 'EVENT_OUT_OF_ORDER') return 'dependency';
  if ([408, 429, 500, 502, 503, 504].includes(status) ||
      code === 'RATE_LIMITED' || code === 'DEPENDENCY_UNAVAILABLE' || code === 'INTERNAL_ERROR') {
    return 'recoverable';
  }
  return 'action_required';
}

export const retryScheduleMs = [2_000, 5_000, 15_000, 60_000, 300_000] as const;

export function nextRetryDelayMs(attemptCount: number, random: () => number = Math.random) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error('Contagem de tentativa inválida.');
  }
  const nominal = retryScheduleMs[Math.min(attemptCount - 1, retryScheduleMs.length - 1)]!;
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(nominal * jitter);
}
