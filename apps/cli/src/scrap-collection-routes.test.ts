import { describe, expect, it, vi } from 'vitest';
import { runScrapCollectionRouteCommand, scrapCollectionRouteSummary } from './scrap-collection-routes';

describe('scrap collection route CLI', () => {
  it('returns the simple operator list without binding an operator', () => {
    const result = scrapCollectionRouteSummary({ routeId: '11111111-1111-4111-8111-111111111111',
      routeDate: '2026-11-05', generatedAt: '2026-11-05T12:00:00Z', candidates: [{
        scheduleId: '22222222-2222-4222-8222-222222222222', clientName: 'Loja A',
        address: 'Rua A, 10', promisedWeightKg: '100', location: { latitude: -5.8, longitude: -35.2 },
      }] });
    expect(result).toMatchObject({ routeId: '11111111-1111-4111-8111-111111111111',
      stops: [{ suggestedOrder: 1, clientName: 'Loja A', address: 'Rua A, 10', promisedWeightKg: '100' }] });
    expect(result).not.toHaveProperty('operatorId');
  });
});

describe('scrap collection route operational CLI', () => {
  const route = { schemaVersion: 1, routeId: '00000000-0000-4000-8000-000000000010', version: 1,
    routeDate: '2026-11-06', status: 'draft', operatorId: null, generatedAt: '2026-11-05T18:00:00Z',
    policy: { version: 'scrap-route-proximity-v1', method: 'centroid-edge-nearest-neighbor', distance: 'haversine_approximation' },
    stops: [{ scheduleId: '00000000-0000-4000-8000-000000000001', clientName: 'Loja A', address: 'Rua A',
      promisedWeightKg: '10', location: null, suggestedOrder: 1, approximateFromPreviousKm: null,
      geographyStatus: 'pending_location', result: null }],
    counts: { total: 1, geocoded: 0, pendingLocation: 1, completed: 0 } };

  it('lists routes for one date without sending a body', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ schemaVersion: 1, date: '2026-11-06',
      generatedAt: '2026-11-05T18:00:00Z', routes: [route] }));
    await runScrapCollectionRouteCommand({ baseUrl: 'https://example.test', token: 'token', operation: 'list',
      date: '2026-11-06', request });
    expect(String(request.mock.calls[0]?.[0])).toContain('/api/v1/logistics/routes?date=2026-11-06');
    expect(request.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('sends versioned approval with an idempotency key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...route, status: 'approved', version: 2 }));
    await runScrapCollectionRouteCommand({ baseUrl: 'https://example.test', token: 'token', operation: 'approve',
      routeId: route.routeId, idempotencyKey: '00000000-0000-4000-8000-000000000099',
      body: { schemaVersion: 1, expectedVersion: 1, reason: 'Conferida' }, request });
    expect(String(request.mock.calls[0]?.[0])).toContain(`${route.routeId}/approve`);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('idempotency-key'))
      .toBe('00000000-0000-4000-8000-000000000099');
  });
});
