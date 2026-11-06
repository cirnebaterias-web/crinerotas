import { describe, expect, it } from 'vitest';
import { proposeWeeklyRoutes, weeklyRoutePolicy } from './weekly-route-proposals';

const sellerId = '11111111-1111-4111-8111-111111111111';
const id = (value: number) => `22222222-2222-4222-8222-${String(value).padStart(12, '0')}`;
const candidate = (value: number, overrides: Record<string, unknown> = {}) => ({
  clientId: id(value), name: `Cliente ${value}`, status: 'active', daysSinceLastPurchase: 60,
  periodicityDays: 30, averageMonthlyVolume: 100, scrapDebtKg: 100,
  location: { latitude: -5.8, longitude: -35.2 }, hasNavigableAddress: true, ...overrides,
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
