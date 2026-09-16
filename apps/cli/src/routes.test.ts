import { describe, expect, it, vi } from 'vitest';
import {
  mePath,
  myTodayRoutePath,
  routeExecutionOrderPath,
  routesPath,
} from '@cirne/contracts';
import { runRouteRoundTrip } from './routes';

const managerToken = 'manager-private-token';
const sellerToken = 'seller-private-token';
const managerId = '50000000-0000-4000-8000-000000000001';
const sellerId = '11111111-1111-4111-8111-111111111111';
const routeId = '20000000-0000-4000-8000-000000000001';
const routeVersionId = '30000000-0000-4000-8000-000000000001';
const firstStopId = '40000000-0000-4000-8000-000000000001';
const secondStopId = '40000000-0000-4000-8000-000000000002';

function identityResponse(url: URL, authorization: string | null) {
  if (url.pathname !== mePath) return null;
  if (authorization === `Bearer ${managerToken}`) {
    return Response.json({
      id: managerId,
      displayName: 'Gestor A Sintético',
      roles: ['manager'],
      capabilities: ['identity.read_self', 'route.plan_scoped', 'route.read_scoped', 'route.reorder_scoped'],
      scopeIds: [sellerId],
      status: 'active',
    });
  }
  if (authorization === `Bearer ${sellerToken}`) {
    return Response.json({
      id: sellerId,
      displayName: 'Vendedor A Sintético',
      roles: ['seller'],
      capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'sync.write_self'],
      scopeIds: [sellerId],
      status: 'active',
    });
  }
  return Response.json({}, { status: 401 });
}

function publishedTodayRoute(order: readonly string[], executionVersion: number, firstPriority = 1) {
  const stops = [
    {
      routeVersionStopId: firstStopId,
      plannedOrder: 1,
      priority: firstPriority,
      client: {
        id: '10000000-0000-4000-8000-000000000001',
        externalReference: 'SYN-001',
        name: 'Cliente Sintético 01',
        address: 'Endereço sintético 01',
        latitude: null,
        longitude: null,
        portfolioReference: 'CARTEIRA-SINTETICA-A',
      },
    },
    {
      routeVersionStopId: secondStopId,
      plannedOrder: 3,
      priority: 0,
      client: {
        id: '10000000-0000-4000-8000-000000000002',
        externalReference: 'SYN-002',
        name: 'Cliente Sintético 02',
        address: 'Endereço sintético 02',
        latitude: null,
        longitude: null,
        portfolioReference: 'CARTEIRA-SINTETICA-A',
      },
    },
  ];
  return {
    schemaVersion: 2,
    availability: 'available',
    route: {
      schemaVersion: 2,
      routeId,
      routeVersionId,
      versionNumber: 1,
      serviceDate: '2026-09-15',
      status: 'published',
      publishedAt: '2026-09-15T12:00:00.000Z',
      executionVersion,
      seller: { id: sellerId, displayName: 'Vendedor A Sintético' },
      stops: order.map((stopId, index) => ({
        ...stops.find(({ routeVersionStopId }) => routeVersionStopId === stopId)!,
        executionOrder: index + 1,
        status: 'pending',
        executionVersion: 1,
      })),
    },
  };
}

describe('route round-trip CLI service', () => {
  it.each([
    { routeId: managerId },
    { routeVersionId: managerId },
    { executionVersion: 99 },
    { pendingStopIds: [secondStopId] },
    { pendingStopIds: [firstStopId, secondStopId] },
  ])('rejects inconsistent reorder confirmation %j', async (inconsistent) => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const identity = identityResponse(url, new Headers(init?.headers).get('authorization'));
      if (identity) return identity;
      if (url.pathname === myTodayRoutePath) {
        return Response.json(publishedTodayRoute([firstStopId, secondStopId], 2));
      }
      return Response.json({
        schemaVersion: 1, routeId, routeVersionId, executionVersion: 3,
        changed: true, pendingStopIds: [secondStopId, firstStopId], ...inconsistent,
      });
    });
    await expect(runRouteRoundTrip('http://127.0.0.1:3000', managerToken, sellerToken, request))
      .rejects.toThrow('diverge do comando');
  });

  it('creates, publishes, reorders and reloads a route without returning private content', async () => {
    let routePublished = false;
    let executionVersion = 2;
    let order = [firstStopId, secondStopId];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      const identity = identityResponse(url, authorization);
      if (identity) return identity;
      if (url.pathname === routesPath) {
        const body = JSON.parse(String(init?.body)) as { serviceDate: string; sellerId: string; stops: object[] };
        return Response.json({
          schemaVersion: 1,
          routeId,
          routeVersionId,
          versionNumber: 1,
          expectedVersion: 1,
          serviceDate: body.serviceDate,
          sellerId: body.sellerId,
          status: 'draft',
          stops: body.stops.map((stop, index) => ({
            ...stop,
            routeVersionStopId: index === 0 ? firstStopId : secondStopId,
          })),
        }, { status: 201 });
      }
      if (url.pathname === `/api/v1/routes/${routeId}/publish`) {
        routePublished = true;
        return Response.json({
          schemaVersion: 1,
          routeId,
          routeVersionId,
          versionNumber: 1,
          expectedVersion: 2,
          status: 'published',
          publishedBy: managerId,
          publishedAt: '2026-09-15T12:00:00.000Z',
          stopCount: 2,
        });
      }
      if (url.pathname === myTodayRoutePath) {
        return Response.json(routePublished
          ? publishedTodayRoute(order, executionVersion)
          : { schemaVersion: 2, availability: 'empty', serviceDate: '2026-09-15' });
      }
      if (url.pathname === routeExecutionOrderPath(routeId)) {
        const body = JSON.parse(String(init?.body)) as { expectedVersion: number; pendingStopIds: string[] };
        const changed = body.pendingStopIds.some((stopId, index) => stopId !== order[index]);
        if (changed) {
          order = [...body.pendingStopIds];
          executionVersion += 1;
        }
        return Response.json({
          schemaVersion: 1,
          routeId,
          routeVersionId,
          executionVersion,
          changed,
          pendingStopIds: body.pendingStopIds,
        });
      }
      return Response.json({}, { status: 404 });
    });

    const result = await runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    );
    expect(result).toEqual({
      status: 'ok',
      routeId,
      routeVersion: 1,
      executionVersion: 3,
      routeStatus: 'published',
      stopCount: 2,
      checks: { created: true, published: true, loadedBySeller: true, reordered: 'applied' },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|client|address|snapshot/i);
    expect(request).toHaveBeenCalledTimes(8);
  });

  it('rejects a manager token without the planning capability', async () => {
    const request = vi.fn(async () => Response.json({
      id: managerId,
      displayName: 'Gestor A Sintético',
      roles: ['manager'],
      capabilities: ['identity.read_self'],
      scopeIds: [sellerId],
      status: 'active',
    }));
    await expect(runRouteRoundTrip('http://127.0.0.1:3000', managerToken, sellerToken, request))
      .rejects.toThrow('não possui capacidade');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('calls the reorder endpoint and recognizes an already canonical order', async () => {
    const targetOrder = [secondStopId, firstStopId];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      const identity = identityResponse(url, authorization);
      if (identity) return identity;
      if (url.pathname === myTodayRoutePath) return Response.json(publishedTodayRoute(targetOrder, 3));
      if (url.pathname === routeExecutionOrderPath(routeId)) {
        const body = JSON.parse(String(init?.body)) as { pendingStopIds: string[] };
        return Response.json({
          schemaVersion: 1,
          routeId,
          routeVersionId,
          executionVersion: 3,
          changed: false,
          pendingStopIds: body.pendingStopIds,
        });
      }
      return Response.json({}, { status: 404 });
    });

    await expect(runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    )).resolves.toEqual({
      status: 'ok',
      routeId,
      routeVersion: 1,
      executionVersion: 3,
      routeStatus: 'published',
      stopCount: 2,
      checks: { created: true, published: true, loadedBySeller: true, reordered: 'already_canonical' },
    });
    expect(request).toHaveBeenCalledTimes(5);
  });
});
