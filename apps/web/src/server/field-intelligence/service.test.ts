import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import {
  currentFieldIntelligenceWeek,
  getFieldIntelligence,
  normalizeFieldIntelligenceFilters,
} from './service';

const manager: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111', displayName: 'Gestor A',
  roles: ['manager'], capabilities: ['route.read_scoped'],
  scopeIds: ['22222222-2222-4222-8222-222222222222'], status: 'active',
};
const emptyResults = {
  schemaVersion: 1 as const, section: 'results' as const,
  filters: { section: 'results' as const, from: '2026-10-26', to: '2026-11-01' },
  generatedAt: '2026-10-28T15:00:00.000Z', lastConfirmedAt: null, nextCursor: null,
  serverVisibilityNote: 'Somente fatos recebidos e confirmados pelo servidor estão incluídos; conteúdo ainda apenas no aparelho não é conhecido.' as const,
  indicators: { records: 0, completedVisits: 0 }, records: [],
};

describe('field intelligence service', () => {
  it('calculates the current week with a controlled operational clock', () => {
    expect(currentFieldIntelligenceWeek('America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });

  it('normalizes defaults and rejects an inverted range', () => {
    expect(normalizeFieldIntelligenceFilters({ section: 'stock' }, 'UTC', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toMatchObject({ section: 'stock', from: '2026-10-26', to: '2026-11-01' });
    expect(() => normalizeFieldIntelligenceFilters({
      section: 'stock', from: '2026-11-01', to: '2026-10-26',
    }, 'UTC')).toThrow('posterior');
  });

  it('denies actors without manager scope before the repository', async () => {
    const repository = { get: vi.fn() };
    await expect(getFieldIntelligence(
      { ...manager, roles: ['administrator'], scopeIds: [] },
      { section: 'results', from: '2026-10-26', to: '2026-11-01' },
      'UTC', repository,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('validates the canonical repository response', async () => {
    const repository = { get: vi.fn().mockResolvedValue(emptyResults) };
    await expect(getFieldIntelligence(
      manager, emptyResults.filters, 'UTC', repository,
    )).resolves.toEqual(emptyResults);
  });
});
