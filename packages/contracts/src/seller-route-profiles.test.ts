import { describe, expect, it } from 'vitest';
import { sellerRouteProfileSchema, updateSellerRouteProfileRequestSchema } from './seller-route-profiles';

const sellerId = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';

describe('seller route profile contracts', () => {
  it('accepts a future offboarding with no invented replacement city', () => {
    expect(updateSellerRouteProfileRequestSchema.parse({ schemaVersion: 1, expectedVersion: 1,
      offboardingAt: '2026-12-01T03:00:00Z', baseCity: null,
      reason: 'Desligamento futuro informado pela gestão.', idempotencyKey: key })).toBeTruthy();
  });

  it('represents an unassigned portfolio without losing the seller identity', () => {
    expect(sellerRouteProfileSchema.parse({ schemaVersion: 1, sellerId, displayName: 'Felipe',
      lifecycle: 'inactive', offboardingAt: '2026-12-01T03:00:00Z', baseCity: null,
      portfolioState: 'unassigned', version: 2, updatedAt: '2026-12-01T03:00:00Z' }))
      .toMatchObject({ sellerId, portfolioState: 'unassigned' });
  });

  it('rejects an incomplete municipal reference', () => {
    expect(updateSellerRouteProfileRequestSchema.safeParse({ schemaVersion: 1, expectedVersion: 0,
      offboardingAt: null, baseCity: { city: 'Natal', state: 'RN' },
      reason: 'Configuração inicial de cidade-base.', idempotencyKey: key }).success).toBe(false);
  });
});
