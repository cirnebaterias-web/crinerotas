import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import {
  changeScrapCollectionRoute, createScrapCollectionRoute, listScrapCollectionRoutes,
  requireScrapCollectionRouteManager, requireScrapCollectionRouteRead, type ScrapCollectionRouteRepository,
} from './service';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function identity(role: 'manager' | 'administrator' | 'logistics', capabilities: string[]): MeResponse {
  return { id, displayName: 'Ator sintético', status: 'active', roles: [role], capabilities,
    scopeIds: role === 'manager' ? [id] : [] };
}
function repository(): ScrapCollectionRouteRepository {
  return { list: vi.fn(), get: vi.fn(), create: vi.fn(), change: vi.fn() };
}

describe('scrap collection route service boundaries', () => {
  it('requires an active manager or administrator with dispatch capability', () => {
    expect(() => requireScrapCollectionRouteManager(identity('logistics', ['scrap.execute_pickups']))).toThrow();
    expect(() => requireScrapCollectionRouteManager(identity('administrator', []))).toThrow();
    expect(() => requireScrapCollectionRouteManager({ ...identity('manager', ['scrap.dispatch_pickups']), scopeIds: [] })).toThrow();
    expect(() => requireScrapCollectionRouteManager(identity('manager', ['scrap.dispatch_pickups']))).not.toThrow();
    expect(() => requireScrapCollectionRouteRead(identity('logistics', ['scrap.execute_pickups']))).not.toThrow();
  });

  it('rejects malformed commands before persistence', async () => {
    const repo = repository(); const manager = identity('manager', ['scrap.dispatch_pickups']);
    await expect(createScrapCollectionRoute(manager, key,
      { schemaVersion: 1, routeDate: '2026-11-06', scheduleIds: [id, id] }, repo)).rejects.toThrow();
    await expect(changeScrapCollectionRoute(manager, id, 'approve', key,
      { schemaVersion: 1, expectedVersion: 0, reason: 'Aprovar' }, repo)).rejects.toThrow();
    await expect(changeScrapCollectionRoute(manager, id, 'revise', key,
      { schemaVersion: 1, expectedVersion: 4, reason: 'Revisão', scheduleIds: [id, id] }, repo)).rejects.toThrow();
    expect(repo.create).not.toHaveBeenCalled(); expect(repo.change).not.toHaveBeenCalled();
  });

  it('fails closed when persistence returns an invalid projection', async () => {
    const repo = repository(); const manager = identity('manager', ['scrap.dispatch_pickups']);
    vi.mocked(repo.list).mockResolvedValue({ routes: [{ private: true }] });
    await expect(listScrapCollectionRoutes(manager, '2026-11-06', repo))
      .rejects.toThrow('Rotas de coleta temporariamente indisponíveis.');
  });
});
