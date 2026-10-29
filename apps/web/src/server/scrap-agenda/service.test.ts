import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { getScrapAgenda, normalizeScrapAgendaFilters, requireScrapAgendaAccess } from './service';

const sellerId = '22222222-2222-4222-8222-222222222222';
const manager: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111', displayName: 'Gestor A',
  roles: ['manager'], capabilities: ['scrap.read_operations'], scopeIds: [sellerId], status: 'active',
};
const emptyAgenda = {
  schemaVersion: 1 as const,
  filters: { from: '2026-10-26', to: '2026-11-01', status: 'pending' as const },
  generatedAt: '2026-10-28T15:00:00.000Z', lastServerConfirmedAt: null,
  indicators: { records: 0, scheduledKg: '0' }, records: [], nextCursor: null,
  serverVisibilityNote: 'Somente agendamentos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.' as const,
};

describe('scrap agenda service', () => {
  it('normalizes the operational week and rejects invalid ranges', () => {
    expect(normalizeScrapAgendaFilters({}, 'America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual({ from: '2026-10-26', to: '2026-11-01', status: 'pending' });
    expect(() => normalizeScrapAgendaFilters({
      from: '2026-11-01', to: '2026-10-26',
    }, 'UTC')).toThrow('posterior');
    expect(() => normalizeScrapAgendaFilters({ status: 'completed' }, 'UTC')).toThrow();
  });

  it('allows scoped managers and existing operational roles only with capability', () => {
    expect(() => requireScrapAgendaAccess(manager)).not.toThrow();
    expect(() => requireScrapAgendaAccess({ ...manager, roles: ['logistics'], scopeIds: [] })).not.toThrow();
    expect(() => requireScrapAgendaAccess({ ...manager, roles: ['administrator'], scopeIds: [] })).not.toThrow();
    expect(() => requireScrapAgendaAccess({ ...manager, roles: ['seller'], scopeIds: [] })).toThrow();
    expect(() => requireScrapAgendaAccess({ ...manager, capabilities: [] })).toThrow();
    expect(() => requireScrapAgendaAccess({ ...manager, status: 'inactive' })).toThrow();
  });

  it('denies a manager filter outside scope before the repository', async () => {
    const repository = { get: vi.fn() };
    await expect(getScrapAgenda(manager, {
      ...emptyAgenda.filters, sellerId: '33333333-3333-4333-8333-333333333333',
    }, repository)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('validates the canonical repository response', async () => {
    const repository = { get: vi.fn().mockResolvedValue(emptyAgenda) };
    await expect(getScrapAgenda(manager, emptyAgenda.filters, repository)).resolves.toEqual(emptyAgenda);
  });
});
