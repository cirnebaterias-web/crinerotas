import { describe, expect, it, vi } from 'vitest';
import { getSellerRouteProfile, updateSellerRouteProfile } from './seller-route-profiles';

const sellerId = '11111111-1111-4111-8111-111111111111';
const profile = { schemaVersion: 1, sellerId, displayName: 'Felipe', lifecycle: 'offboarding_scheduled',
  offboardingAt: '2026-12-01T03:00:00Z', portfolioState: 'assigned', version: 2,
  updatedAt: '2026-11-05T12:00:00Z', baseCity: null };

describe('seller route profile CLI', () => {
  it('reads the operational state through the public API', async () => {
    const request = vi.fn(async () => Response.json(profile));
    expect(await getSellerRouteProfile('http://localhost:3000', 'token', sellerId, request as never))
      .toMatchObject({ sellerId, lifecycle: 'offboarding_scheduled' });
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(calls[0]?.[0].toString()).toContain(`/seller-route-profiles/${sellerId}`);
  });

  it('schedules offboarding without requiring a replacement city', async () => {
    const request = vi.fn(async () => Response.json({ schemaVersion: 1, replayed: false, profile }));
    const result = await updateSellerRouteProfile('http://localhost:3000', 'token', sellerId, {
      schemaVersion: 1, expectedVersion: 1, offboardingAt: '2026-12-01T03:00:00Z', baseCity: null,
      reason: 'Desligamento futuro informado pela gestão.',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    }, request as never);
    expect(result.profile.portfolioState).toBe('assigned');
    const calls = request.mock.calls as unknown as Array<[URL, RequestInit]>;
    expect(JSON.parse(String(calls[0]?.[1].body))).toMatchObject({ baseCity: null });
  });

  it('rejects an unsafe origin before attaching the bearer token', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(getSellerRouteProfile('http://example.com', 'secret', sellerId, request))
      .rejects.toThrow('HTTPS ou localhost');
    expect(request).not.toHaveBeenCalled();
  });
});
