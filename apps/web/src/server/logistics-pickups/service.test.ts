import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { changeLogisticsPickup, listLogisticsOperators, listLogisticsPickups, requireLogisticsPickupAccess, type LogisticsPickupRepository } from './service';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function identity(role: 'manager' | 'administrator' | 'logistics' | 'seller', capabilities: string[]): MeResponse {
  return { id, displayName: 'Ator sintético', status: 'active', roles: [role],
    capabilities, scopeIds: role === 'manager' ? [id] : [] };
}
function repository(): LogisticsPickupRepository {
  return { list: vi.fn(), operators: vi.fn(), change: vi.fn() };
}
describe('logistics pickup service boundaries', () => {
  it('requires specific role plus capability instead of legacy operations read', () => {
    expect(() => requireLogisticsPickupAccess(identity('logistics', ['scrap.read_operations']), 'read')).toThrow();
    expect(() => requireLogisticsPickupAccess(identity('seller', ['scrap.execute_pickups']), 'execute')).toThrow();
    expect(() => requireLogisticsPickupAccess(identity('administrator', []), 'manage')).toThrow();
    expect(() => requireLogisticsPickupAccess(identity('logistics', ['scrap.execute_pickups']), 'read')).not.toThrow();
  });
  it('rejects blocked/scopeless identities and prevents operators from listing staff', async () => {
    const manager = identity('manager', ['scrap.dispatch_pickups']);
    expect(() => requireLogisticsPickupAccess({ ...manager, status: 'inactive' }, 'manage')).toThrow();
    expect(() => requireLogisticsPickupAccess({ ...manager, scopeIds: [] }, 'manage')).toThrow();
    const repo = repository();
    await expect(listLogisticsOperators(identity('logistics', ['scrap.execute_pickups']), repo)).rejects.toThrow();
    expect(repo.operators).not.toHaveBeenCalled();
  });
  it('rejects malformed mutations before persistence and invalid repository responses', async () => {
    const operator = identity('logistics', ['scrap.execute_pickups']); const repo = repository();
    await expect(changeLogisticsPickup(operator, id, 'result', id,
      { schemaVersion: 1, expectedVersion: 1, outcome: 'not_collected', actualWeightKg: '100', reason: 'Ausente' }, repo)).rejects.toThrow();
    expect(repo.change).not.toHaveBeenCalled();
    vi.mocked(repo.list).mockResolvedValue({ sql: 'private data' });
    await expect(listLogisticsPickups(operator, '2026-11-04', repo)).rejects.toThrow('Logística temporariamente indisponível.');
  });
});
