import {
  type OfflineOutboxEvent,
  type OfflinePartition,
  type SyncBatchResponse,
  type SyncErrorCode,
  type SyncResult,
} from '@cirne/contracts';
import { classifySyncFailure, nextRetryDelayMs, toSyncCommand } from '@cirne/domain';
import type { OfflineRepository } from './repository';
import { SyncTransportError, type SyncTransport } from './sync-transport';

export interface SyncQueueRepository {
  reserveOutboxBatch(
    partition: OfflinePartition,
    now: string,
    leaseUntil: string,
    limit?: number,
  ): Promise<OfflineOutboxEvent[]>;
  recordOutboxFailure(
    partition: OfflinePartition,
    eventId: string,
    input: {
      status: 'recoverable_error' | 'action_required';
      code: SyncErrorCode;
      nextAttemptAt?: string;
    },
  ): Promise<OfflineOutboxEvent | undefined>;
  applySyncConfirmation(partition: OfflinePartition, result: SyncResult): Promise<boolean>;
}

export interface SyncRunSummary {
  attempted: number;
  confirmed: number;
  recoverable: number;
  actionRequired: number;
  authenticationRequired: boolean;
}

export type RefreshSession = () => Promise<boolean>;

const activeRuns = new Map<string, Promise<SyncRunSummary>>();
const maxTransportAttempts = 2;
const requestTimeoutMs = 30_000;
export const syncRefreshTimeoutMs = 5_000;
const leaseBufferMs = 5_000;
export const syncLeaseMs = maxTransportAttempts * requestTimeoutMs + syncRefreshTimeoutMs + leaseBufferMs;

function partitionKey(partition: OfflinePartition) {
  return `${partition.userId}:${partition.deviceId}`;
}

function emptySummary(): SyncRunSummary {
  return { attempted: 0, confirmed: 0, recoverable: 0, actionRequired: 0, authenticationRequired: false };
}

export class SyncEngine {
  constructor(
    private readonly repository: SyncQueueRepository,
    private readonly transport: SyncTransport,
    private readonly refreshSession: RefreshSession = async () => false,
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  synchronize(partition: OfflinePartition) {
    const key = partitionKey(partition);
    const running = activeRuns.get(key);
    if (running) return running;
    const next = this.run(partition).finally(() => activeRuns.delete(key));
    activeRuns.set(key, next);
    return next;
  }

  private async run(partition: OfflinePartition): Promise<SyncRunSummary> {
    const startedAt = this.now();
    const events = await this.repository.reserveOutboxBatch(
      partition,
      startedAt.toISOString(),
      new Date(startedAt.getTime() + syncLeaseMs).toISOString(),
      25,
    );
    if (events.length === 0) return emptySummary();

    const summary = { ...emptySummary(), attempted: events.length };
    let response: SyncBatchResponse;
    try {
      response = await this.sendWithSingleRefresh(partition, events);
    } catch (error) {
      const transportError = error instanceof SyncTransportError
        ? error
        : new SyncTransportError(0, 'DEPENDENCY_UNAVAILABLE');
      await this.persistTransportFailure(partition, events, transportError, summary);
      return summary;
    }

    const results = new Map(response.results.map((result) => [result.eventId, result]));
    for (const event of events) {
      const result = results.get(event.eventId);
      if (!result) {
        await this.persistRecoverable(partition, event, 'DEPENDENCY_UNAVAILABLE');
        summary.recoverable += 1;
        continue;
      }
      if (result.status === 'confirmed') {
        await this.repository.applySyncConfirmation(partition, result);
        summary.confirmed += 1;
        continue;
      }
      if (result.status === 'recoverable_error' || result.error.code === 'EVENT_OUT_OF_ORDER') {
        await this.persistRecoverable(partition, event, result.error.code);
        summary.recoverable += 1;
      } else {
        await this.repository.recordOutboxFailure(partition, event.eventId, {
          status: 'action_required',
          code: result.error.code,
        });
        summary.actionRequired += 1;
      }
    }
    return summary;
  }

  private async sendWithSingleRefresh(partition: OfflinePartition, events: OfflineOutboxEvent[]) {
    const batch = { deviceId: partition.deviceId, events: events.map(toSyncCommand) };
    try {
      return await this.transport.send(batch);
    } catch (error) {
      if (!(error instanceof SyncTransportError) || classifySyncFailure(error.status, error.code) !== 'authentication_required') {
        throw error;
      }
      if (!await this.refreshSessionWithinBudget()) throw error;
      return this.transport.send(batch);
    }
  }

  private refreshSessionWithinBudget() {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(false), syncRefreshTimeoutMs);
      this.refreshSession().then(finish, () => finish(false));
    });
  }

  private async persistRecoverable(
    partition: OfflinePartition,
    event: OfflineOutboxEvent,
    code: SyncErrorCode,
  ) {
    const delay = nextRetryDelayMs(event.attemptCount, this.random);
    await this.repository.recordOutboxFailure(partition, event.eventId, {
      status: 'recoverable_error',
      code,
      nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
    });
  }

  private async persistTransportFailure(
    partition: OfflinePartition,
    events: OfflineOutboxEvent[],
    error: SyncTransportError,
    summary: SyncRunSummary,
  ) {
    const failureClass = classifySyncFailure(error.status, error.code);
    for (const event of events) {
      if (
        failureClass === 'recoverable' ||
        failureClass === 'dependency' ||
        failureClass === 'authentication_required'
      ) {
        await this.persistRecoverable(partition, event, error.code);
        summary.recoverable += 1;
      } else {
        await this.repository.recordOutboxFailure(partition, event.eventId, {
          status: 'action_required',
          code: error.code,
        });
        summary.actionRequired += 1;
      }
    }
    summary.authenticationRequired = failureClass === 'authentication_required';
  }
}

export function createSyncEngine(
  repository: OfflineRepository,
  transport: SyncTransport,
  refreshSession?: RefreshSession,
) {
  return new SyncEngine(repository, transport, refreshSession);
}
