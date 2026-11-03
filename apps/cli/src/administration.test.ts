import { describe, expect, it, vi } from 'vitest';
import {
  formatAdministration, loadAdministration, mutateAdministrationUser,
} from './administration';

const userId = '10000000-0000-4000-8000-000000000002';
const updatedAt = '2026-10-30T03:00:00.000Z';
const user = { id: userId, displayName: 'Gestor', status: 'active', blockedAt: null, updatedAt,
  roles: ['manager'], sellerScopeIds: [], lastAdministrativeChange: null };
const snapshot = { schemaVersion: 1, generatedAt: updatedAt, users: [user],
  roles: [{ code: 'manager', name: 'Gestor' }], parameters: {
    mutationAvailability: 'blocked_pending_business_approval',
    blockers: ['AB-02', 'AB-03', 'AB-09'], current: null } };

describe('administration CLI', () => {
  it('loads the canonical projection without putting the token in the URL or output', async () => {
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[0].toString()).toBe('http://127.0.0.1:3000/api/v1/administration');
      expect(new Headers(args[1]?.headers).get('authorization')).toBe('Bearer private-token');
      return Response.json(snapshot);
    });
    const result = await loadAdministration('http://127.0.0.1:3000', 'private-token', request);
    expect(formatAdministration(result)).toContain('1 usuario(s), 1 ativo(s)');
    expect(formatAdministration(result)).not.toContain('private-token');
  });

  it('mutates through PUT with the same strict command', async () => {
    const command = { schemaVersion: 1 as const, expectedUpdatedAt: updatedAt, status: 'active' as const,
      roles: ['manager' as const], sellerScopeIds: [], reason: 'Ajuste administrativo aprovado',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[0].toString()).toBe(`http://127.0.0.1:3000/api/v1/administration/users/${userId}`);
      expect(args[1]?.method).toBe('PUT');
      expect(JSON.parse(String(args[1]?.body))).toEqual(command);
      return Response.json({ schemaVersion: 1, replayed: false, user });
    });
    await expect(mutateAdministrationUser('http://127.0.0.1:3000', 'token', userId, command, request))
      .resolves.toMatchObject({ replayed: false, user: { id: userId } });
  });

  it('normalizes an uppercase UUID before composing the mutation path', async () => {
    const command = { schemaVersion: 1 as const, expectedUpdatedAt: updatedAt, status: 'active' as const,
      roles: ['manager' as const], sellerScopeIds: [], reason: 'Ajuste administrativo aprovado',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[0].toString()).toContain(`/users/${userId}`);
      return Response.json({ schemaVersion: 1, replayed: false, user });
    });
    await expect(mutateAdministrationUser('http://127.0.0.1:3000', 'token', userId.toUpperCase(), command, request))
      .resolves.toMatchObject({ user: { id: userId } });
  });

  it('maps authorization and version conflicts to stable exit codes', async () => {
    const failure = (status: number) => vi.fn(async () => Response.json({ error: {
      code: status === 403 ? 'FORBIDDEN' : 'VERSION_CONFLICT', message: 'Falha', recoverable: false,
      timestamp: updatedAt, requestId: '30000000-0000-4000-8000-000000000001',
    } }, { status }));
    await expect(loadAdministration('http://127.0.0.1:3000', 'token', failure(403)))
      .rejects.toMatchObject({ exitCode: 77 });
    const command = { schemaVersion: 1 as const, expectedUpdatedAt: updatedAt, status: 'active' as const,
      roles: ['manager' as const], sellerScopeIds: [], reason: 'Ajuste administrativo aprovado',
      idempotencyKey: '20000000-0000-4000-8000-000000000001' };
    await expect(mutateAdministrationUser('http://127.0.0.1:3000', 'token', userId, command, failure(409)))
      .rejects.toMatchObject({ exitCode: 78 });
  });
});
