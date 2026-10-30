import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAdministrationRepository } from './supabase-repository';

const updatedAt = '2026-10-30T03:00:00.000Z';
const user = { id: '10000000-0000-4000-8000-000000000002', displayName: 'Gestor', status: 'active',
  blockedAt: null, updatedAt, roles: ['manager'], sellerScopeIds: [], lastAdministrativeChange: null };
const snapshot = { schemaVersion: 1, generatedAt: updatedAt, users: [user],
  roles: [{ code: 'manager', name: 'Gestor' }], parameters: {
    mutationAvailability: 'blocked_pending_business_approval',
    blockers: ['AB-02', 'AB-03', 'AB-09'], current: null } };

function repositoryResults(...results: Array<{ data: unknown; error: { message?: string } | null }>) {
  const abortSignal = vi.fn();
  for (const result of results) abortSignal.mockResolvedValueOnce(result);
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const schema = vi.fn().mockReturnValue({ rpc });
  return { repository: new SupabaseAdministrationRepository({ schema } as unknown as SupabaseClient), rpc };
}

describe('Supabase administration repository', () => {
  it('uses only the narrow administration RPCs', async () => {
    const result = { schemaVersion: 1, replayed: false, user };
    const { repository, rpc } = repositoryResults(
      { data: snapshot, error: null }, { data: result, error: null },
    );
    await expect(repository.getSnapshot()).resolves.toEqual(snapshot);
    const command = { schemaVersion: 1 as const, expectedUpdatedAt: updatedAt, status: 'active' as const,
      roles: ['manager' as const], sellerScopeIds: [], reason: 'Ajuste administrativo aprovado',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    await expect(repository.updateUser(user.id, command, 'web')).resolves.toEqual(result);
    expect(rpc).toHaveBeenNthCalledWith(1, 'get_administration_snapshot');
    expect(rpc).toHaveBeenNthCalledWith(2, 'update_administration_user', {
      p_user_id: user.id, p_command: command, p_origin: 'web',
    });
  });

  it('preserves known conflicts and sanitizes unknown failures', async () => {
    const known = repositoryResults({ data: null, error: { message: 'VERSION_CONFLICT' } }).repository;
    await expect(known.getSnapshot()).rejects.toMatchObject({ code: 'VERSION_CONFLICT', recoverable: false });
    const unknown = repositoryResults({ data: null, error: { message: 'private table leaked' } }).repository;
    await expect(unknown.getSnapshot()).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', recoverable: true });
  });
});
