import { describe, expect, it } from 'vitest';
import type { CanonicalRoute } from '@cirne/contracts';
import { orderPendingFromLocation } from './route-location-order';

function stop(id: string, status: CanonicalRoute['stops'][number]['status'], order: number,
  latitude: string | null, longitude: string | null) {
  return { routeVersionStopId: id, plannedOrder: order, executionOrder: order, priority: 0, status,
    executionVersion: 1, client: { id, externalReference: null, name: id, address: 'Rua', latitude,
      longitude, portfolioReference: null } } as CanonicalRoute['stops'][number];
}

describe('daily route GPS ordering', () => {
  it('orders only pending stops by approximate proximity and leaves visited slots fixed', () => {
    const visited = stop('11111111-1111-4111-8111-111111111111', 'completed', 1, '-5.80', '-35.20');
    const far = stop('22222222-2222-4222-8222-222222222222', 'pending', 2, '-6.80', '-36.20');
    const near = stop('33333333-3333-4333-8333-333333333333', 'pending', 3, '-5.81', '-35.21');
    const missing = stop('44444444-4444-4444-8444-444444444444', 'pending', 4, null, null);
    expect(orderPendingFromLocation([visited, far, missing, near], { latitude: -5.8, longitude: -35.2 })
      .map(({ routeVersionStopId }) => routeVersionStopId)).toEqual([
        visited.routeVersionStopId, near.routeVersionStopId, far.routeVersionStopId, missing.routeVersionStopId,
      ]);
  });
});
