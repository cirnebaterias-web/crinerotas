import {
  administrationSnapshotSchema,
  updateAdministrationUserResultSchema,
  type RouteErrorCode,
  type UpdateAdministrationUserRequest,
} from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';
import type { AdministrationRepository } from './service';

const knownDatabaseCodes = new Set<RouteErrorCode>([
  'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED',
]);

function databaseFailure(error: { message?: string }) {
  const code = knownDatabaseCodes.has(error.message as RouteErrorCode)
    ? error.message as RouteErrorCode
    : 'DEPENDENCY_UNAVAILABLE';
  return new RouteServiceFailure(code, publicRouteMessage(code), code === 'DEPENDENCY_UNAVAILABLE');
}

export class SupabaseAdministrationRepository implements AdministrationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getSnapshot() {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('get_administration_snapshot')
        .abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw new RouteServiceFailure(
        'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
      );
    }
    if (result.error) throw databaseFailure(result.error);
    const parsed = administrationSnapshotSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new RouteServiceFailure(
        'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
      );
    }
    return parsed.data;
  }

  async updateUser(userId: string, command: UpdateAdministrationUserRequest, origin: 'web' | 'cli') {
    let result: { data: unknown; error: { message?: string } | null };
    try {
      result = await this.client.schema('api').rpc('update_administration_user', {
        p_user_id: userId, p_command: command, p_origin: origin,
      }).abortSignal(AbortSignal.timeout(10_000));
    } catch {
      throw new RouteServiceFailure(
        'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
      );
    }
    if (result.error) throw databaseFailure(result.error);
    const parsed = updateAdministrationUserResultSchema.safeParse(result.data);
    if (!parsed.success) {
      throw new RouteServiceFailure(
        'DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true,
      );
    }
    return parsed.data;
  }
}
