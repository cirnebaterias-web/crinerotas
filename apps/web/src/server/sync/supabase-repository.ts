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

  async synchronize(deviceId: string, command: SyncCommand) {
    const query = this.client.schema('api').rpc('sync_event', {
      p_device_id: deviceId,
      p_command: command,
    }).abortSignal(AbortSignal.timeout(30_000));
    const { data, error } = await query;
    if (error) throw mapDatabaseFailure(error.message);

    const parsed = syncResultSchema.safeParse(data);
    if (!parsed.success || parsed.data.status !== 'confirmed') {
      throw new SyncEventFailure(
        'DEPENDENCY_UNAVAILABLE',
        publicSyncMessage('DEPENDENCY_UNAVAILABLE'),
        true,
      );
    }
    return parsed.data;
  }
}
