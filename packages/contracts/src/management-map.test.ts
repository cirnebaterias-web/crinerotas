import { describe, expect, it } from 'vitest';
import { managementMapQuerySchema, managementMapResponseSchema } from './management-map';

const response = {
  schemaVersion: 1 as const, serviceDate: '2026-10-29', generatedAt: '2026-10-29T12:00:00.000Z',
  availability: 'available' as const,
  totals: { routes: 1, stops: 2, positioned: 1, unpositioned: 1 },
  routes: [{
    routeId: '10000000-0000-4000-8000-000000000001', routeVersionId: '10000000-0000-4000-8000-000000000002',
    versionNumber: 1, seller: { id: '10000000-0000-4000-8000-000000000003', displayName: 'Vendedor' },
    stops: [{ routeVersionStopId: '10000000-0000-4000-8000-000000000004', plannedOrder: 1, executionOrder: 1,
      priority: 0, client: { id: '10000000-0000-4000-8000-000000000005', name: 'Cliente A', address: 'Rua A' },
      status: 'pending' as const, location: { latitude: '-5.79', longitude: '-35.21' } },
    { routeVersionStopId: '10000000-0000-4000-8000-000000000006', plannedOrder: 2, executionOrder: 2,
      priority: 0, client: { id: '10000000-0000-4000-8000-000000000007', name: 'Cliente B', address: 'Rua B' },
      status: 'completed' as const, location: null }],
  }],
  serverVisibilityNote: 'O mapa usa coordenadas cadastrais do snapshot publicado; não exibe GPS observado nem representa trajeto por ruas.' as const,
};

describe('management map contract', () => {
  it('accepts a complete scoped projection and optional date query', () => {
    expect(managementMapQuerySchema.parse({})).toEqual({});
    expect(managementMapQuerySchema.parse({ serviceDate: '2026-10-29' })).toEqual({ serviceDate: '2026-10-29' });
    expect(managementMapResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects invalid coordinates and inconsistent totals', () => {
    expect(managementMapResponseSchema.safeParse({ ...response, routes: [{ ...response.routes[0]!, stops: [
      { ...response.routes[0]!.stops[0]!, location: { latitude: '91', longitude: '-35.21' } },
    ] }] }).success).toBe(false);
    expect(managementMapResponseSchema.safeParse({ ...response, totals: { ...response.totals, positioned: 2 } }).success).toBe(false);
  });

  it('does not admit observed GPS or arbitrary filters', () => {
    expect(managementMapQuerySchema.safeParse({ sellerId: '10000000-0000-4000-8000-000000000003' }).success).toBe(false);
    expect(managementMapResponseSchema.safeParse({ ...response, gps: { latitude: '-5.8', longitude: '-35.2' } }).success).toBe(false);
  });
});
