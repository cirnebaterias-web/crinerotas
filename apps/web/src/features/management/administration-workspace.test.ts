import { describe, expect, it } from 'vitest';
import type { AdministrationUser } from '@cirne/contracts';
import { filterAdministrationUsers, replaceAdministrationUser } from './administration-state';

const updatedAt = '2026-10-30T03:00:00.000Z';
const users: AdministrationUser[] = [
  { id: '10000000-0000-4000-8000-000000000001', displayName: 'Ana Gestora', status: 'active', blockedAt: null, updatedAt,
    roles: ['manager'], sellerScopeIds: [], lastAdministrativeChange: null },
  { id: '10000000-0000-4000-8000-000000000002', displayName: 'Bruno Vendedor', status: 'inactive', blockedAt: updatedAt, updatedAt,
    roles: ['seller'], sellerScopeIds: [], lastAdministrativeChange: null },
];
describe('administration workspace state', () => {
  it('searches by name, role and status without mutating the confirmed snapshot', () => {
    expect(filterAdministrationUsers(users, 'gestora')).toEqual([users[0]]);
    expect(filterAdministrationUsers(users, 'vendedor')).toEqual([users[1]]);
    expect(filterAdministrationUsers(users, 'bloqueado')).toEqual([users[1]]);
    expect(users).toHaveLength(2);
  });
  it('replaces only the canonical updated user', () => {
    const updated = { ...users[1]!, status: 'active' as const, blockedAt: null };
    const result = replaceAdministrationUser(users, updated);
    expect(result).toEqual([users[0], updated]); expect(result[0]).toBe(users[0]);
  });
});
