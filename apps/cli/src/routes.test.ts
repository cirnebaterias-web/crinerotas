import { describe, expect, it, vi } from 'vitest';
import { mePath, myTodayRoutePath, routesPath } from '@cirne/contracts';
import { runRouteRoundTrip } from './routes';

const managerToken = 'manager-private-token';
const sellerToken = 'seller-private-token';
const managerId = '50000000-0000-4000-8000-000000000001';
const sellerId = '11111111-1111-4111-8111-111111111111';
const routeId = '20000000-0000-4000-8000-000000000001';
const routeVersionId = '30000000-0000-4000-8000-000000000001';

function publishedTodayRoute(firstPriority = 1) {
  return {
    schemaVersion: 1,
    availability: 'available',
    route: {
      schemaVersion: 1, routeId, routeVersionId, versionNumber: 1,
      serviceDate: '2026-09-15', status: 'published', publishedAt: '2026-09-15T12:00:00.000Z',
      seller: { id: sellerId, displayName: 'Vendedor A Sintético' },
      stops: [1, 2].map((value) => ({
        routeVersionStopId: `40000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
        plannedOrder: value === 1 ? 1 : 3, executionOrder: value === 1 ? 1 : 3,
        priority: value === 1 ? firstPriority : 0, status: 'pending', executionVersion: 1,
        client: {
          id: `10000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
          externalReference: `SYN-00${value}`, name: `Cliente Sintético 0${value}`,
          address: `Endereço sintético 0${value}`, latitude: null, longitude: null,
          portfolioReference: 'CARTEIRA-SINTETICA-A',
        },
      })),
    },
  };
}

describe('route round-trip CLI service', () => {
  it('creates, publishes and loads a route without returning private content', async () => {
    let routePublished = false;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      if (url.pathname === mePath && authorization === `Bearer ${managerToken}`) {
        return Response.json({
          id: managerId, displayName: 'Gestor A Sintético', roles: ['manager'],
          capabilities: ['identity.read_self', 'route.plan_scoped', 'route.read_scoped'],
          scopeIds: [sellerId], status: 'active',
        });
      }
      if (url.pathname === mePath && authorization === `Bearer ${sellerToken}`) {
        return Response.json({
          id: sellerId, displayName: 'Vendedor A Sintético', roles: ['seller'],
          capabilities: ['identity.read_self', 'route.read_self', 'sync.write_self'],
          scopeIds: [sellerId], status: 'active',
        });
      }
      if (url.pathname === routesPath) {
        const body = JSON.parse(String(init?.body)) as { serviceDate: string; sellerId: string; stops: object[] };
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId, versionNumber: 1, expectedVersion: 1,
          serviceDate: body.serviceDate, sellerId: body.sellerId, status: 'draft',
          stops: body.stops.map((stop, index) => ({
            ...stop, routeVersionStopId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          })),
        }, { status: 201 });
      }
      if (url.pathname === `/api/v1/routes/${routeId}/publish`) {
        routePublished = true;
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId, versionNumber: 1, expectedVersion: 2,
          status: 'published', publishedBy: managerId, publishedAt: '2026-09-15T12:00:00.000Z', stopCount: 2,
        });
      }
      if (url.pathname === myTodayRoutePath) {
        return Response.json(routePublished
          ? publishedTodayRoute()
          : { schemaVersion: 1, availability: 'empty', serviceDate: '2026-09-15' });
      }
      return Response.json({}, { status: 404 });
    });

    const result = await runRouteRoundTrip(
      'http://127.0.0.1:3000',
      managerToken,
      sellerToken,
      request,
    );
    expect(result).toEqual({
      status: 'ok', routeId, routeVersion: 1, routeStatus: 'published', stopCount: 2,
      checks: { created: true, published: true, loadedBySeller: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|client|address|snapshot/i);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('rejects a manager token without the planning capability', async () => {
    const request = vi.fn(async () => Response.json({
      id: managerId, displayName: 'Gestor A Sintético', roles: ['manager'],
      capabilities: ['identity.read_self'], scopeIds: [sellerId], status: 'active',
    }));
    await expect(runRouteRoundTrip('http://127.0.0.1:3000', managerToken, sellerToken, request))
      .rejects.toThrow('não possui capacidade');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects equal-sized route results whose stop composition changed', async () => {
    const responses = [
      {
        id: managerId, displayName: 'Gestor A Sintético', roles: ['manager'],
        capabilities: ['identity.read_self', 'route.plan_scoped', 'route.read_scoped'],
        scopeIds: [sellerId], status: 'active',
      },
      {
        id: sellerId, displayName: 'Vendedor A Sintético', roles: ['seller'],
        capabilities: ['identity.read_self', 'route.read_self', 'sync.write_self'],
        scopeIds: [sellerId], status: 'active',
      },
      { schemaVersion: 1, availability: 'empty', serviceDate: '2026-09-15' },
      {
        schemaVersion: 1, routeId, routeVersionId, versionNumber: 1, expectedVersion: 1,
        serviceDate: '2026-09-15', sellerId, status: 'draft',
        stops: [
          {
            routeVersionStopId: '40000000-0000-4000-8000-000000000001',
            clientId: '10000000-0000-4000-8000-000000000001', plannedOrder: 1, priority: 1,
          },
          {
            routeVersionStopId: '40000000-0000-4000-8000-000000000002',
            clientId: '10000000-0000-4000-8000-000000000002', plannedOrder: 3, priority: 0,
          },
        ],
      },
      {
        schemaVersion: 1, routeId, routeVersionId, versionNumber: 1, expectedVersion: 2,
        status: 'published', publishedBy: managerId, publishedAt: '2026-09-15T12:00:00.000Z', stopCount: 2,
      },
      publishedTodayRoute(0),
    ];
    const request = vi.fn(async () => Response.json(responses.shift()));

    await expect(runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    )).rejects.toThrow('diverge da versão publicada');
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('reuses a matching synthetic route already published for the day', async () => {
    const responses = [
      {
        id: managerId, displayName: 'Gestor A Sintético', roles: ['manager'],
        capabilities: ['identity.read_self', 'route.plan_scoped', 'route.read_scoped'],
        scopeIds: [sellerId], status: 'active',
      },
      {
        id: sellerId, displayName: 'Vendedor A Sintético', roles: ['seller'],
        capabilities: ['identity.read_self', 'route.read_self', 'sync.write_self'],
        scopeIds: [sellerId], status: 'active',
      },
      publishedTodayRoute(),
    ];
    const request = vi.fn(async () => Response.json(responses.shift()));

    await expect(runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    )).resolves.toMatchObject({
      status: 'ok', routeId, routeVersion: 1, routeStatus: 'published', stopCount: 2,
    });
    expect(request).toHaveBeenCalledTimes(3);
  });
});
