import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@cirne/contracts';
import { assemblePilotMetrics, getPilotMetrics, normalizePilotMetricsFilters } from './service';

const manager: MeResponse = {
  id: '11111111-1111-4111-8111-111111111111', displayName: 'Gestor sintético',
  roles: ['manager'], capabilities: ['route.read_scoped'],
  scopeIds: ['22222222-2222-4222-8222-222222222222'], status: 'active',
};
const filters = { from: '2026-10-26', to: '2026-11-01' };
const projection = {
  generatedAt: '2026-10-28T15:00:00.000Z', lastServerConfirmedAt: '2026-10-28T14:00:00.000Z',
  totals: {
    completed: 3, requiredComplete: 3, scrapReported: 2, commercialActionReported: 3,
    syncWithin24h: 1, syncEligible: 2, windowOpen: 1, clockSuspicious: 1,
  },
  records: [], nextCursor: null,
};

describe('pilot metrics service', () => {
  it('normalizes the operational week and paired dates', () => {
    expect(normalizePilotMetricsFilters({}, 'America/Sao_Paulo', {
      now: () => new Date('2026-10-28T15:00:00.000Z'),
    })).toEqual(filters);
    expect(() => normalizePilotMetricsFilters({ from: '2026-10-01' }, 'UTC')).toThrow('juntas');
  });

  it('denies actors without manager scope before repository access', async () => {
    const repository = { get: vi.fn() };
    await expect(getPilotMetrics(
      { ...manager, roles: ['seller'], scopeIds: [] }, filters, 'UTC', repository,
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('calculates deterministic provisional observations and keeps external metrics unevaluable', () => {
    const result = assemblePilotMetrics(filters, projection);
    expect(result.metrics.map((metric) => metric.id)).toEqual([
      'SM-01', 'SM-02', 'SM-03', 'SM-04', 'SM-05', 'SM-06', 'SM-07', 'SM-08', 'SM-09',
    ]);
    expect(result.metrics[1]).toMatchObject({ assessment: 'provisional_met', observation: { percentage: '100' } });
    expect(result.metrics[2]).toMatchObject({ assessment: 'provisional_not_met', observation: { percentage: '66.67' } });
    expect(result.metrics[4]).toMatchObject({
      coverage: 'partial_server_view', assessment: 'provisional_not_met',
      observation: { percentage: '50', exclusions: { windowOpen: 1, clockSuspicious: 1 } },
    });
    for (const index of [0, 5, 6, 7, 8]) {
      expect(result.metrics[index]).toMatchObject({
        coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
      });
    }
  });

  it('returns null observations and not_evaluable when denominators are zero', () => {
    const zero = assemblePilotMetrics(filters, {
      ...projection, lastServerConfirmedAt: null,
      totals: Object.fromEntries(Object.keys(projection.totals).map((key) => [key, 0])) as typeof projection.totals,
    });
    expect(zero.metrics[1]).toMatchObject({ assessment: 'not_evaluable', observation: { denominator: 0, percentage: null } });
    expect(zero.metrics[4]).toMatchObject({ assessment: 'not_evaluable', observation: { denominator: 0, percentage: null } });
  });
});
