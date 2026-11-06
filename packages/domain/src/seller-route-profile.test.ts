import { describe, expect, it } from 'vitest';
import { normalizedSellerRouteProfile, weeklyProposalReadiness } from './seller-route-profile';

const base = { schemaVersion: 1 as const, sellerId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Felipe', lifecycle: 'offboarding_scheduled' as const,
  offboardingAt: '2026-12-01T03:00:00Z', portfolioState: 'assigned' as const, version: 2,
  updatedAt: '2026-11-05T12:00:00Z', baseCity: { city: 'São Pedro', state: 'RN',
    ibgeCode: '2412708', latitude: -5.9, longitude: -35.63,
    reference: 'municipal_seat' as const, source: 'IBGE' as const } };

describe('seller route profile', () => {
  it('keeps the seller eligible before the effective offboarding instant', () => {
    expect(weeklyProposalReadiness(base, new Date('2026-11-30T12:00:00Z'))).toMatchObject({ ready: true });
  });

  it('stops new proposals at the effective instant', () => {
    expect(weeklyProposalReadiness(base, new Date('2026-12-01T03:00:00Z')))
      .toEqual({ ready: false, reason: 'seller_inactive' });
  });

  it('normalizes the portfolio to unassigned without deleting history', () => {
    expect(normalizedSellerRouteProfile(base, new Date('2026-12-02T00:00:00Z')))
      .toMatchObject({ sellerId: base.sellerId, lifecycle: 'inactive', portfolioState: 'unassigned' });
  });

  it('preserves an explicitly inactive lifecycle before an optional offboarding date', () => {
    expect(normalizedSellerRouteProfile({ ...base, lifecycle: 'inactive', offboardingAt: null },
      new Date('2026-11-05T12:00:00Z')))
      .toMatchObject({ lifecycle: 'inactive', portfolioState: 'assigned' });
  });

  it('blocks a newly hired seller until the city is configured', () => {
    expect(weeklyProposalReadiness({ ...base, displayName: 'Novo vendedor', lifecycle: 'active',
      offboardingAt: null, baseCity: null }, new Date('2026-11-05T12:00:00Z')))
      .toEqual({ ready: false, reason: 'base_city_missing' });
  });
});
