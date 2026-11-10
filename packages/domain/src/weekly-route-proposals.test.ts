import { describe, expect, it } from 'vitest';
import { analyzeVisitCoverage, analyzeWeeklyRouteCandidate, classifyDailyRoute, coverageCadenceDays,
  maxDailyLegDistanceKm, pointInPolygon, proposeWeeklyRoutes, weeklyRoutePolicy } from './weekly-route-proposals';

const sellerId = '11111111-1111-4111-8111-111111111111';
const id = (value: number) => `22222222-2222-4222-8222-${String(value).padStart(12, '0')}`;
const candidate = (value: number, overrides: Record<string, unknown> = {}) => ({
  clientId: id(value), name: `Cliente ${value}`, status: 'active' as const, daysSinceLastPurchase: 60,
  periodicityDays: 30, averageMonthlyVolume: 100, recentVolume3: 300, previousVolume3: 300,
  opportunitySegments: [], scrapDebtKg: 100, scrapBalanceState: 'debtor' as const,
  location: { latitude: -5.8, longitude: -35.2 }, hasNavigableAddress: true,
  visitHistoryStatus: 'unavailable' as const, lastCompletedVisitAt: null, ...overrides,
});
const proposal = (candidates: unknown[]) => proposeWeeklyRoutes({
  weekStart: '2026-11-02', generatedAt: '2026-11-04T12:00:00-03:00',
  origin: { kind: 'base_city', sellerId, city: 'Parnamirim', state: 'RN', ibgeCode: '2403251',
    latitude: -5.8, longitude: -35.2, reference: 'municipal_seat', source: 'IBGE', configVersion: 1 }, candidates,
});

describe('weekly route proposal rules', () => {
  it('keeps exactly 180 days and excludes 181 days as inactive/lost', () => {
    const result = proposal([
      candidate(1, { daysSinceLastPurchase: 180 }),
      candidate(2, { daysSinceLastPurchase: 181 }),
    ]);
    expect(result.days.flatMap(({ suggestions }) => suggestions).map(({ clientId }) => clientId)).toEqual([id(1)]);
    expect(result.excluded).toContainEqual({ clientId: id(2), reason: 'inactive_lost' });
    expect(result.counts).toMatchObject({ evaluated: 2, suggested: 1, inactiveLost: 1 });
    expect(result.policy).toEqual(weeklyRoutePolicy);
    expect(result.policy.version).toBe('weekly-route-rules-v3');
  });

  it('keeps missing history distinct and does not invent recency', () => {
    const result = proposal([candidate(1, { daysSinceLastPurchase: null, periodicityDays: null })]);
    expect(result.counts).toMatchObject({ suggested: 0, inactiveLost: 0, noPurchaseHistory: 1 });
    expect(result.excluded).toEqual([{ clientId: id(1), reason: 'no_purchase_history' }]);
  });

  it('retains address-only clients and flags missing distance', () => {
    const result = proposal([candidate(1, { location: null, hasNavigableAddress: true })]);
    expect(result.days[0]?.suggestions[0]).toMatchObject({ clientId: id(1),
      approximateDistanceKm: null, locationPending: true });
    expect(result.days[0]?.suggestions[0]?.reasons).toContain('destino navegável sem distância calculável');
  });

  it('uses deterministic ordering and limits each weekday to ten unique clients', () => {
    const candidates = Array.from({ length: 58 }, (_, index) => candidate(index + 1, {
      daysSinceLastPurchase: (index % 180) + 1, scrapDebtKg: index * 30,
    }));
    const first = proposal(candidates);
    const second = proposal([...candidates].reverse());
    expect(first.days).toEqual(second.days);
    expect(first.days).toHaveLength(5);
    expect(first.days.every(({ suggestions }) => suggestions.length === 10)).toBe(true);
    expect(new Set(first.days.flatMap(({ suggestions }) => suggestions.map(({ clientId }) => clientId))).size).toBe(50);
  });

  it('uses purchase periodicity and recent decline in the commercial priority explanation', () => {
    const result = analyzeWeeklyRouteCandidate(candidate(1, {
      daysSinceLastPurchase: 75, periodicityDays: 30, recentVolume3: 120,
      previousVolume3: 240, averageMonthlyVolume: 80,
    }), { latitude: -5.8, longitude: -35.2 });
    expect(result).toMatchObject({ cycleDelayDays: 45, cycleDelayPercent: 150,
      purchaseTrend: 'falling', potential: 'high' });
    expect(result.reasons).toContain('45 dias além do ciclo (150% de atraso)');
    expect(result.reasons).toContain('volume recente caiu 50%');
  });

  it('keeps active buying customers in the routine and prioritizes overdue visit coverage', () => {
    const result = proposal([
      candidate(1, { daysSinceLastPurchase: 5, periodicityDays: 30, visitHistoryStatus: 'available',
        lastCompletedVisitAt: '2026-08-01T12:00:00-03:00' }),
      candidate(2, { daysSinceLastPurchase: 60, periodicityDays: 30, visitHistoryStatus: 'available',
        lastCompletedVisitAt: '2026-10-20T12:00:00-03:00' }),
    ]);
    const suggestions = result.days.flatMap(({ suggestions }) => suggestions);
    expect(suggestions[0]).toMatchObject({ clientId: id(1), coverageState: 'overdue' });
    expect(suggestions.map(({ clientId }) => clientId)).toContain(id(2));
    expect(result.counts).toMatchObject({ coverageDue: 1, coveragePlanned: 1, coveragePending: 0 });
  });

  it('distinguishes unavailable visit history from a confirmed first visit', () => {
    expect(coverageCadenceDays).toBe(28);
    expect(analyzeVisitCoverage(candidate(1), '2026-11-02')).toMatchObject({ coverageState: 'unavailable' });
    expect(analyzeVisitCoverage(candidate(2, { visitHistoryStatus: 'available', lastCompletedVisitAt: null }),
      '2026-11-02')).toMatchObject({ coverageState: 'never_visited' });
    expect(analyzeVisitCoverage(candidate(3, { visitHistoryStatus: 'available',
      lastCompletedVisitAt: '2026-10-08T23:30:00-03:00' }), '2026-11-02'))
      .toMatchObject({ coverageState: 'due_this_week', nextVisitDueOn: '2026-11-05' });
  });

  it('forms a coherent travel week when the highest coverage priority is far from the base', () => {
    const result = proposal([
      candidate(1, { location: { latitude: -6.7, longitude: -35.2 }, visitHistoryStatus: 'available',
        lastCompletedVisitAt: '2026-06-01T12:00:00-03:00' }),
      candidate(2, { location: { latitude: -6.71, longitude: -35.21 }, visitHistoryStatus: 'available',
        lastCompletedVisitAt: '2026-06-15T12:00:00-03:00' }),
      candidate(3, { location: { latitude: -5.8, longitude: -35.2 }, visitHistoryStatus: 'available',
        lastCompletedVisitAt: '2026-10-25T12:00:00-03:00' }),
    ]);
    expect(result.strategy).toMatchObject({ kind: 'trip' });
    expect(result.days.flatMap(({ suggestions }) => suggestions).map(({ clientId }) => clientId))
      .toEqual(expect.arrayContaining([id(1), id(2)]));
    expect(result.excluded).toContainEqual({ clientId: id(3), reason: 'weekly_strategy_mismatch' });
  });

  it('never puts two positioned consecutive stops more than 30 km apart on the same day', () => {
    const result = proposal([
      candidate(1, { location: { latitude: -5.8, longitude: -35.2 } }),
      candidate(2, { location: { latitude: -5.8, longitude: -34.8 } }),
    ]);
    const assignedDays = result.days.flatMap(({ dayIndex, suggestions }) =>
      suggestions.map(({ clientId }) => ({ clientId, dayIndex })));
    expect(maxDailyLegDistanceKm).toBe(30);
    expect(assignedDays.find(({ clientId }) => clientId === id(1))?.dayIndex)
      .not.toBe(assignedDays.find(({ clientId }) => clientId === id(2))?.dayIndex);
  });

  it('keeps the latest positioned stop when an unpositioned address appears between stops', () => {
    const result = proposal([
      candidate(1, { location: { latitude: -5.8, longitude: -35.2 } }),
      candidate(2, { location: null, hasNavigableAddress: true }),
      candidate(3, { location: { latitude: -5.8, longitude: -34.8 } }),
    ]);
    const assignedDays = result.days.flatMap(({ dayIndex, suggestions }) =>
      suggestions.map(({ clientId }) => ({ clientId, dayIndex })));
    expect(assignedDays.find(({ clientId }) => clientId === id(1))?.dayIndex)
      .not.toBe(assignedDays.find(({ clientId }) => clientId === id(3))?.dayIndex);
  });

  it('keeps an incompatible sixth geographic cluster explicit for manager review', () => {
    const locations = [
      { latitude: -5.35, longitude: -35.2 }, { latitude: -6.25, longitude: -35.2 },
      { latitude: -5.8, longitude: -34.75 }, { latitude: -5.8, longitude: -35.65 },
      { latitude: -5.48, longitude: -34.88 }, { latitude: -6.12, longitude: -35.52 },
    ];
    const result = proposal(locations.map((location, index) => candidate(index + 1, { location })));
    expect(result.counts).toMatchObject({ suggested: 5, needsReview: 1 });
    expect(result.excluded).toContainEqual({ clientId: id(6), reason: 'daily_distance_limit' });
  });

  it('distinguishes weekly capacity overflow from geographic incompatibility', () => {
    const result = proposal(Array.from({ length: 51 }, (_, index) => candidate(index + 1, {
      location: { latitude: -5.8, longitude: -35.2 },
    })));
    expect(result.counts).toMatchObject({ suggested: 50, needsReview: 1 });
    expect(result.excluded).toContainEqual({ clientId: id(51), reason: 'daily_capacity_reached' });
  });

  it('classifies weekly days as local or trip from the seller base city', () => {
    const origin = { latitude: -5.8, longitude: -35.2 };
    expect(classifyDailyRoute(origin, [{ latitude: -5.9, longitude: -35.25 }])).toBe('local');
    expect(classifyDailyRoute(origin, [{ latitude: -6.6, longitude: -35.2 }])).toBe('trip');
  });

  it('selects only positioned clients inside a manager-drawn polygon', () => {
    const polygon = [{ latitude: -6, longitude: -36 }, { latitude: -5, longitude: -36 },
      { latitude: -5, longitude: -35 }, { latitude: -6, longitude: -35 }];
    expect(pointInPolygon({ latitude: -5.5, longitude: -35.5 }, polygon)).toBe(true);
    expect(pointInPolygon({ latitude: -4.9, longitude: -35.5 }, polygon)).toBe(false);
  });

  it('excludes inactive and unnavigable clients into explicit review groups', () => {
    const result = proposal([
      candidate(1, { status: 'inactive' }),
      candidate(2, { location: null, hasNavigableAddress: false }),
    ]);
    expect(result.excluded).toEqual([
      { clientId: id(1), reason: 'client_not_active' },
      { clientId: id(2), reason: 'no_navigable_location' },
    ]);
    expect(result.counts.needsReview).toBe(2);
  });

  it('requires a Monday and rejects duplicate clients', () => {
    expect(() => proposeWeeklyRoutes({ weekStart: '2026-11-03', generatedAt: '2026-11-04T12:00:00Z',
      origin: { kind: 'base_city', sellerId, city: 'Natal', state: 'RN', ibgeCode: '2408102', latitude: 0, longitude: 0,
        reference: 'municipal_seat', source: 'IBGE', configVersion: 1 }, candidates: [] })).toThrow(/segunda-feira/);
    expect(() => proposal([candidate(1), candidate(1)])).toThrow(/repetido/);
  });

  it('requires a versioned base city and rejects current GPS as weekly origin', () => {
    expect(() => proposeWeeklyRoutes({ weekStart: '2026-11-02', generatedAt: '2026-11-04T12:00:00Z',
      origin: { kind: 'base_city', sellerId, city: 'Natal', state: 'RN', ibgeCode: '2408102', latitude: 0, longitude: 0,
        reference: 'municipal_seat', source: 'IBGE', configVersion: 0 }, candidates: [] })).toThrow();
    expect(() => proposeWeeklyRoutes({ weekStart: '2026-11-02', generatedAt: '2026-11-04T12:00:00Z',
      origin: { kind: 'current_gps', sellerId, latitude: 0, longitude: 0, accuracyM: 5,
        capturedAt: '2026-11-04T11:59:00Z' }, candidates: [] })).toThrow();
  });
});
