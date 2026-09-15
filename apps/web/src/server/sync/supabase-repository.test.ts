import { describe, expect, it, vi } from 'vitest';
import type { SyncCommand } from '@cirne/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseSyncEventRepository } from './supabase-repository';

const command: SyncCommand = {
  eventId: '10000000-0000-4000-8000-000000000001',
  idempotencyKey: '20000000-0000-4000-8000-000000000001',
  operation: 'visit.draft.saved',
  schemaVersion: 1,
  sequence: 1,
  aggregateType: 'visit_draft',
  aggregateId: '40000000-0000-4000-8000-000000000001',
  occurredAt: '2026-09-14T12:00:01.000Z',
  payload: {
    draftOfflineId: '40000000-0000-4000-8000-000000000001',
    routeVersionStopId: '30000000-0000-4000-8000-000000000001',
    acknowledged: true,
  },
};

function clientReturning(data: unknown) {
  const abortSignal = vi.fn().mockResolvedValue({ data, error: null });
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return new SupabaseSyncEventRepository({ schema } as unknown as SupabaseClient);
}

describe('SupabaseSyncEventRepository', () => {
  it('rejects a canonical confirmation that belongs to another event', async () => {
    const repository = clientReturning({
      eventId: '10000000-0000-4000-8000-000000000002',
      status: 'confirmed',
      canonicalId: command.aggregateId,
      confirmedAt: '2026-09-14T12:01:00.000Z',
    });

    await expect(repository.synchronize('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', command))
      .rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
