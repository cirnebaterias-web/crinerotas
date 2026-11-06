import {
  sellerRouteProfileSchema,
  type SellerRouteProfile,
  type WeeklyRouteBaseCityOrigin,
} from '@cirne/contracts';

export type WeeklyProposalReadiness =
  | { ready: true; origin: WeeklyRouteBaseCityOrigin }
  | { ready: false; reason: 'portfolio_unassigned' | 'seller_inactive' | 'base_city_missing' };

export class SellerBaseCityNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SellerBaseCityNotConfiguredError';
  }
}

export function weeklyProposalReadiness(profileInput: unknown, now: Date): WeeklyProposalReadiness {
  const profile = sellerRouteProfileSchema.parse(profileInput);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError('Instante de avaliação inválido.');
  const offboardingMs = profile.offboardingAt ? Date.parse(profile.offboardingAt) : null;
  const effectivelyInactive = profile.lifecycle === 'inactive'
    || (offboardingMs !== null && offboardingMs <= nowMs);
  if (profile.portfolioState === 'unassigned') return { ready: false, reason: 'portfolio_unassigned' };
  if (effectivelyInactive) return { ready: false, reason: 'seller_inactive' };
  if (!profile.baseCity) return { ready: false, reason: 'base_city_missing' };
  return { ready: true, origin: {
    kind: 'base_city', sellerId: profile.sellerId, ...profile.baseCity,
    configVersion: profile.version,
  } };
}

export function normalizedSellerRouteProfile(input: SellerRouteProfile, now: Date): SellerRouteProfile {
  const profile = sellerRouteProfileSchema.parse(input);
  const offboardingReached = profile.offboardingAt !== null
    && Date.parse(profile.offboardingAt) <= now.getTime();
  return sellerRouteProfileSchema.parse({ ...profile,
    lifecycle: offboardingReached || profile.lifecycle === 'inactive' ? 'inactive'
      : profile.offboardingAt ? 'offboarding_scheduled' : 'active',
    portfolioState: offboardingReached ? 'unassigned' : profile.portfolioState,
  });
}
