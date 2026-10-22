import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { getManagementDay, managementCurrentDate, requireManagementDayAccess } from './service';

const manager: MeResponse = {
  id: '10000000-0000-4000-8000-000000000001', displayName: 'Gestor', status: 'active',
  roles: ['manager'], capabilities: ['route.read_scoped'],
  scopeIds: ['20000000-0000-4000-8000-000000000001'],
};
const empty = {
  schemaVersion: 1 as const, serviceDate: '2026-10-20', generatedAt: '2026-10-20T12:00:00.000Z',
  lastKnownUpdateAt: null, availability: 'empty' as const,
  totals: { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 },
  sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null }, routes: [],
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.' as const,
};

describe('management day service', () => {
  it('authorizes only scoped managers with the explicit capability', () => {
    expect(() => requireManagementDayAccess(manager)).not.toThrow();
    for (const identity of [
      { ...manager, roles: ['seller'] as MeResponse['roles'] },
      { ...manager, roles: ['administrator'] as MeResponse['roles'] },
      { ...manager, capabilities: [] },
      { ...manager, scopeIds: [] },
    ]) expect(() => requireManagementDayAccess(identity)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('calculates the default date with an injected clock and operational zone', () => {
    expect(managementCurrentDate('America/Recife', { now: () => new Date('2026-10-21T01:30:00Z') }))
      .toBe('2026-10-20');
  });

  it('rejects invalid dates before querying the repository', async () => {
    const repository = { getForDate: vi.fn() };
    await expect(getManagementDay(manager, '20/10/2026', 'America/Recife', repository))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.getForDate).not.toHaveBeenCalled();
  });

  it('validates the repository response', async () => {
    const repository = { getForDate: vi.fn(async () => empty) };
    await expect(getManagementDay(manager, '2026-10-20', 'America/Recife', repository)).resolves.toEqual(empty);
    expect(repository.getForDate).toHaveBeenCalledWith('2026-10-20', 'America/Recife');
  });
});
