import { syncResultSchema, type SyncCommand, type SyncErrorCode } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  publicSyncMessage,
  SyncEventFailure,
  type SyncEventRepository,
} from './service';

const databaseErrorCodes = new Set<SyncErrorCode>([
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'EVENT_OUT_OF_ORDER',
  'IDEMPOTENCY_KEY_REUSED',
]);

function mapDatabaseFailure(message: string): SyncEventFailure {
  const code = databaseErrorCodes.has(message as SyncErrorCode)
    ? message as SyncErrorCode
    : 'DEPENDENCY_UNAVAILABLE';
  return new SyncEventFailure(
    code,
    publicSyncMessage(code),
    code === 'DEPENDENCY_UNAVAILABLE',
  );
}

export class SupabaseSyncEventRepository implements SyncEventRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async observeFailure(deviceId: string, command: SyncCommand, failure: SyncEventFailure) {
    try {
      await this.client.schema('api').rpc('observe_sync_failure', {
        p_device_id: deviceId,
        p_event_id: command.eventId,
        p_error_code: failure.code,
        p_recoverable: failure.recoverable,
        p_occurred_at: command.occurredAt,
      }).abortSignal(AbortSignal.timeout(3_000));
    } catch {
      // Observability is best-effort: a failed observation must not replace the original sync result.
    }
  }

  private async resolveFailure(deviceId: string, command: SyncCommand) {
    try {
      await this.client.schema('api').rpc('resolve_sync_failure', {
        p_device_id: deviceId,
        p_event_id: command.eventId,
      }).abortSignal(AbortSignal.timeout(3_000));
    } catch {
      // Resolution is best-effort and cannot invalidate an already confirmed event.
    }
  }

  async synchronize(deviceId: string, command: SyncCommand) {
    const query = this.client.schema('api').rpc('sync_event', {
      p_device_id: deviceId,
      p_command: command,
    }).abortSignal(AbortSignal.timeout(30_000));
    const { data, error } = await query;
    if (error) {
      const failure = mapDatabaseFailure(error.message);
      await this.observeFailure(deviceId, command, failure);
      throw failure;
    }

    const parsed = syncResultSchema.safeParse(data);
    if (!parsed.success || parsed.data.status !== 'confirmed' || parsed.data.eventId !== command.eventId) {
      throw new SyncEventFailure(
        'DEPENDENCY_UNAVAILABLE',
        publicSyncMessage('DEPENDENCY_UNAVAILABLE'),
        true,
      );
    }
    await this.resolveFailure(deviceId, command);
    return parsed.data;
  }
}
