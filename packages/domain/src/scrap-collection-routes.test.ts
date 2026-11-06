import { describe, expect, it } from 'vitest';
import { deriveScrapCollectionRouteStatus, suggestScrapCollectionRoute } from './scrap-collection-routes';

const routeId = '11111111-1111-4111-8111-111111111111';
const candidate = (index: number, latitude: number | null, longitude: number | null) => ({
  scheduleId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  clientName: `Loja ${index}`, address: `Rua ${index}`, promisedWeightKg: `${index * 10}`,
  location: latitude === null || longitude === null ? null : { latitude, longitude },
});
const suggest = (items: unknown[]) => suggestScrapCollectionRoute({ routeId, routeDate: '2026-11-05',
  generatedAt: '2026-11-05T12:00:00Z', candidates: items });

describe('scrap collection route suggestion', () => {
  it('is deterministic and keeps nearby clients consecutive', () => {
    const candidates = [candidate(1, -5.80, -35.20), candidate(2, -5.801, -35.201), candidate(3, -6.2, -36)];
    const first = suggest(candidates); const second = suggest([...candidates].reverse());
    expect(first.stops.map(({ scheduleId }) => scheduleId)).toEqual(second.stops.map(({ scheduleId }) => scheduleId));
    expect(first.stops.slice(1).some(({ approximateFromPreviousKm }) =>
      approximateFromPreviousKm !== null && approximateFromPreviousKm < 1)).toBe(true);
  });

  it('keeps a client with missing coordinates as an explicit planning pending item', () => {
    const route = suggest([candidate(1, -5.8, -35.2), candidate(2, null, null)]);
    expect(route.stops[1]).toMatchObject({ geographyStatus: 'pending_location', approximateFromPreviousKm: null });
    expect(route.counts).toMatchObject({ geocoded: 1, pendingLocation: 1 });
  });

  it('rejects the same schedule twice', () => {
    const item = candidate(1, -5.8, -35.2);
    expect(() => suggest([item, item])).toThrow(/duas vezes/);
  });

  it('does not complete when the highest-order stop finishes before another pending stop', () => {
    expect(deriveScrapCollectionRouteStatus('assigned', [null, 'collected'])).toBe('in_progress');
  });

  it('completes only when every stop has a terminal result', () => {
    expect(deriveScrapCollectionRouteStatus('in_progress', ['collected', 'not_collected'])).toBe('completed');
  });
});
