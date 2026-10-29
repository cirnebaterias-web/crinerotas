import { describe, expect, it, vi } from 'vitest';
import type { ManagementMapResponse, MeResponse } from '@cirne/contracts';
import { getManagementMap, requireManagementMapAccess } from './service';

const manager: MeResponse = {
  id: '10000000-0000-4000-8000-000000000001', displayName: 'Gestor', status: 'active',
  roles: ['manager'], capabilities: ['route.read_scoped'],
  scopeIds: ['10000000-0000-4000-8000-000000000002'],
};
const empty: ManagementMapResponse = {
  schemaVersion: 1, serviceDate: '2026-10-29', generatedAt: '2026-10-29T12:00:00.000Z',
  availability: 'empty', totals: { routes: 0, stops: 0, positioned: 0, unpositioned: 0 }, routes: [],
  serverVisibilityNote: 'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.',
};

describe('management map service', () => {
  it('requires the same active scoped manager boundary as the command center', () => {
    expect(() => requireManagementMapAccess(manager)).not.toThrow();
    for (const identity of [
      { ...manager, status: 'inactive' as const }, { ...manager, roles: ['seller'] as MeResponse['roles'] },
      { ...manager, capabilities: [] }, { ...manager, scopeIds: [] },
    ]) expect(() => requireManagementMapAccess(identity)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('validates the date before the repository and parses its response', async () => {
    const repository = { getForDate: vi.fn(async () => empty) };
    await expect(getManagementMap(manager, '29/10/2026', repository)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.getForDate).not.toHaveBeenCalled();
    await expect(getManagementMap(manager, '2026-10-29', repository)).resolves.toEqual(empty);
    expect(repository.getForDate).toHaveBeenCalledWith('2026-10-29');
  });

  it('rejects a response for another date', async () => {
    await expect(getManagementMap(manager, '2026-10-29', {
      getForDate: vi.fn(async () => ({ ...empty, serviceDate: '2026-10-30' })),
    })).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
