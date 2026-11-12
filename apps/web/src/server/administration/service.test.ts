import { describe, expect, it, vi } from 'vitest';
import type { AdministrationSnapshot, MeResponse } from '@cirne/contracts';
import {
  createAdministrationUser, getAdministrationSnapshot, requireAdministrationAccess,
  resetAdministrationPassword, updateAdministrationUser,
} from './service';

const administrator: MeResponse = {
  id: '10000000-0000-4000-8000-000000000001', displayName: 'Administrador', status: 'active',
  roles: ['administrator'], capabilities: ['identity.manage'], scopeIds: [],
};
const targetId = '10000000-0000-4000-8000-000000000002';
const updatedAt = '2026-10-30T03:00:00.000Z';
const user = { id: targetId, displayName: 'Gestor', status: 'active' as const, blockedAt: null,
  updatedAt, roles: ['manager' as const], sellerScopeIds: [], lastAdministrativeChange: null };
const snapshot: AdministrationSnapshot = { schemaVersion: 1, generatedAt: updatedAt,
  users: [user], roles: [{ code: 'manager', name: 'Gestor' }],
  parameters: { mutationAvailability: 'blocked_pending_business_approval',
    blockers: ['AB-02', 'AB-03', 'AB-09'], current: null } };
const command = { schemaVersion: 1 as const, expectedUpdatedAt: updatedAt, status: 'active' as const,
  roles: ['manager' as const], sellerScopeIds: [], reason: 'Ajuste administrativo aprovado',
  idempotencyKey: '20000000-0000-4000-8000-000000000001' };

describe('administration service', () => {
  it('authorizes only an administrator with identity.manage', () => {
    expect(() => requireAdministrationAccess(administrator)).not.toThrow();
    expect(() => requireAdministrationAccess({ ...administrator, roles: ['manager'] }))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => requireAdministrationAccess({ ...administrator, capabilities: [] }))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('validates the snapshot returned by the repository', async () => {
    const repository = { getSnapshot: vi.fn(async () => snapshot), updateUser: vi.fn() };
    await expect(getAdministrationSnapshot(administrator, repository)).resolves.toEqual(snapshot);
  });

  it('rejects self mutation before calling the repository', async () => {
    const repository = { getSnapshot: vi.fn(), updateUser: vi.fn() };
    await expect(updateAdministrationUser(administrator, administrator.id, command, 'web', repository))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.updateUser).not.toHaveBeenCalled();
  });

  it('validates and returns the canonical updated user', async () => {
    const result = { schemaVersion: 1 as const, replayed: false, user };
    const repository = { getSnapshot: vi.fn(), updateUser: vi.fn(async () => result) };
    await expect(updateAdministrationUser(administrator, targetId, command, 'cli', repository))
      .resolves.toEqual(result);
    expect(repository.updateUser).toHaveBeenCalledWith(targetId, command, 'cli');
  });

  it('enriches the narrow database snapshot with the authorized Auth directory', async () => {
    const repository = { getSnapshot: vi.fn(async () => snapshot), updateUser: vi.fn() };
    const auth = { listUsers: vi.fn(async () => [{ id: targetId, email: 'gestor@example.com',
      emailConfirmed: true, lastSignInAt: null }]) } as never;
    const result = await getAdministrationSnapshot(administrator, repository, auth);
    expect(result.users[0]?.auth).toEqual({ email: 'gestor@example.com', emailConfirmed: true, lastSignInAt: null });
  });

  it('compensates a newly created Auth identity when profile provisioning fails', async () => {
    const createCommand = { schemaVersion: 1 as const, displayName: 'Novo Vendedor',
      email: 'novo@example.com', password: 'Temporaria#2026', roles: ['seller' as const],
      reason: 'Provisionamento aprovado pelo gestor', idempotencyKey: '20000000-0000-4000-8000-000000000002' };
    const repository = { getSnapshot: vi.fn(), updateUser: vi.fn(),
      createUser: vi.fn(async () => { throw new Error('database'); }) };
    const auth = { createUser: vi.fn(async () => ({ id: targetId, email: createCommand.email,
      emailConfirmed: true, lastSignInAt: null, created: true })), deleteUser: vi.fn(async () => undefined) } as never;
    await expect(createAdministrationUser(administrator, createCommand, 'web', repository, auth)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect((auth as { deleteUser: ReturnType<typeof vi.fn> }).deleteUser).toHaveBeenCalledWith(targetId);
  });

  it('blocks self password reset before touching Auth', async () => {
    const reset = { schemaVersion: 1 as const, password: 'Temporaria#2026',
      reason: 'Redefinicao solicitada para o piloto', idempotencyKey: '20000000-0000-4000-8000-000000000003' };
    const auth = { updatePassword: vi.fn() } as never;
    await expect(resetAdministrationPassword(administrator, administrator.id, reset, 'web',
      { getSnapshot: vi.fn(), updateUser: vi.fn() }, auth)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((auth as { updatePassword: ReturnType<typeof vi.fn> }).updatePassword).not.toHaveBeenCalled();
  });
});
