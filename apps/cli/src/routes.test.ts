import { describe, expect, it, vi } from 'vitest';
import {
  mePath,
  myTodayRoutePath,
  routeExecutionOrderPath,
  routePath,
  routesPath,
} from '@cirne/contracts';
import { runRouteRoundTrip } from './routes';

const managerToken = 'manager-private-token';
const sellerToken = 'seller-private-token';
const managerId = '50000000-0000-4000-8000-000000000001';
const sellerId = '11111111-1111-4111-8111-111111111111';
const routeId = '20000000-0000-4000-8000-000000000001';
const initialRouteVersionId = '30000000-0000-4000-8000-000000000001';
const revisedRouteVersionId = '30000000-0000-4000-8000-000000000002';
const firstStopId = '40000000-0000-4000-8000-000000000001';
const secondStopId = '40000000-0000-4000-8000-000000000002';
const firstClientId = '10000000-0000-4000-8000-000000000001';
const retainedClientId = '10000000-0000-4000-8000-000000000002';
const addedClientId = '10000000-0000-4000-8000-000000000003';
const changeReason = 'Ajuste sintetico de composicao para validacao local';

function identityResponse(url: URL, authorization: string | null) {
  if (url.pathname !== mePath) return null;
  if (authorization === `Bearer ${managerToken}`) {
    return Response.json({
      id: managerId,
      displayName: 'Gestor A Sintetico',
      roles: ['manager'],
      capabilities: ['identity.read_self', 'route.plan_scoped', 'route.read_scoped', 'route.reorder_scoped'],
      scopeIds: [sellerId],
      status: 'active',
    });
  }
  if (authorization === `Bearer ${sellerToken}`) {
    return Response.json({
      id: sellerId,
      displayName: 'Vendedor A Sintetico',
      roles: ['seller'],
      capabilities: ['identity.read_self', 'route.read_self', 'route.reorder_self', 'sync.write_self'],
      scopeIds: [sellerId],
      status: 'active',
    });
  }
  return Response.json({}, { status: 401 });
}

function client(id: string, suffix: string) {
  return {
    id,
    externalReference: `SYN-${suffix}`,
    name: `Cliente Sintetico ${suffix}`,
    address: `Endereco sintetico ${suffix}`,
    latitude: null,
    longitude: null,
    portfolioReference: 'CARTEIRA-SINTETICA-A',
  };
}

function initialPublishedTodayRoute(executionVersion = 2) {
  return {
    schemaVersion: 3,
    availability: 'available',
    route: {
      schemaVersion: 3,
      routeId,
      routeVersionId: initialRouteVersionId,
      versionNumber: 1,
      serviceDate: '2026-09-15',
      status: 'published',
      publishedAt: '2026-09-15T12:00:00.000Z',
      executionVersion,
      seller: { id: sellerId, displayName: 'Vendedor A Sintetico' },
      compositionChange: null,
      stops: [
        { routeVersionStopId: firstStopId, plannedOrder: 1, executionOrder: 1, priority: 1,
          status: 'pending', executionVersion: 1, client: client(firstClientId, '01') },
        { routeVersionStopId: secondStopId, plannedOrder: 3, executionOrder: 2, priority: 0,
          status: 'pending', executionVersion: 1, client: client(retainedClientId, '02') },
      ],
    },
  };
}

function revisedPublishedTodayRoute(order: readonly string[], executionVersion: number) {
  const stops = [
    { routeVersionStopId: firstStopId, plannedOrder: 1, priority: 0, client: client(retainedClientId, '02') },
    { routeVersionStopId: secondStopId, plannedOrder: 2, priority: 1, client: client(addedClientId, '03') },
  ];
  return {
    schemaVersion: 3,
    availability: 'available',
    route: {
      schemaVersion: 3,
      routeId,
      routeVersionId: revisedRouteVersionId,
      versionNumber: 2,
      serviceDate: '2026-09-15',
      status: 'published',
      publishedAt: '2026-09-15T12:05:00.000Z',
      executionVersion,
      seller: { id: sellerId, displayName: 'Vendedor A Sintetico' },
      compositionChange: {
        reason: changeReason,
        previousVersionNumber: 1,
        added: [{ id: addedClientId, name: 'Cliente Sintetico 03' }],
        removed: [{ id: firstClientId, name: 'Cliente Sintetico 01' }],
      },
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
        return Response.json(revisedPublishedTodayRoute([firstStopId, secondStopId], 4));
      }
      return Response.json({
        schemaVersion: 1,
        routeId,
        routeVersionId: revisedRouteVersionId,
        executionVersion: 5,
        changed: true,
        pendingStopIds: [secondStopId, firstStopId],
        ...inconsistent,
      });
    });
    await expect(runRouteRoundTrip('http://127.0.0.1:3000', managerToken, sellerToken, request))
      .rejects.toThrow('diverge do comando');
  });

  it('creates, publishes, revises, republishes, reorders and reloads without private content', async () => {
    let routePublished = false;
    let compositionPublished = false;
    let executionVersion = 4;
    let order = [firstStopId, secondStopId];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      const identity = identityResponse(url, authorization);
      if (identity) return identity;
      if (url.pathname === routesPath && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { serviceDate: string; sellerId: string; stops: object[] };
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId: initialRouteVersionId,
          versionNumber: 1, expectedVersion: 1, serviceDate: body.serviceDate,
          sellerId: body.sellerId, status: 'draft',
          stops: body.stops.map((stop, index) => ({
            ...stop, routeVersionStopId: index === 0 ? firstStopId : secondStopId,
          })),
        }, { status: 201 });
      }
      if (url.pathname === routePath(routeId) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { reason: string; stops: object[] };
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId: revisedRouteVersionId,
          versionNumber: 2, expectedVersion: 3, serviceDate: '2026-09-15',
          sellerId, status: 'draft', changed: true, changeReason: body.reason,
          changeSummary: {
            addedClientIds: [addedClientId], removedClientIds: [firstClientId],
            retainedClientIds: [retainedClientId],
          },
          stops: body.stops.map((stop, index) => ({
            ...stop, routeVersionStopId: index === 0 ? firstStopId : secondStopId,
          })),
        });
      }
      if (url.pathname === `${routePath(routeId)}/publish`) {
        if (!routePublished) {
          routePublished = true;
          return Response.json({
            schemaVersion: 1, routeId, routeVersionId: initialRouteVersionId,
            versionNumber: 1, expectedVersion: 2, status: 'published',
            publishedBy: managerId, publishedAt: '2026-09-15T12:00:00.000Z', stopCount: 2,
          });
        }
        compositionPublished = true;
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId: revisedRouteVersionId,
          versionNumber: 2, expectedVersion: 4, status: 'published',
          publishedBy: managerId, publishedAt: '2026-09-15T12:05:00.000Z', stopCount: 2,
        });
      }
      if (url.pathname === myTodayRoutePath) {
        return Response.json(compositionPublished
          ? revisedPublishedTodayRoute(order, executionVersion)
          : routePublished ? initialPublishedTodayRoute()
            : { schemaVersion: 3, availability: 'empty', serviceDate: '2026-09-15' });
      }
      if (url.pathname === routeExecutionOrderPath(routeId)) {
        const body = JSON.parse(String(init?.body)) as { pendingStopIds: string[] };
        const changed = body.pendingStopIds.some((stopId, index) => stopId !== order[index]);
        if (changed) { order = [...body.pendingStopIds]; executionVersion += 1; }
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId: revisedRouteVersionId,
          executionVersion, changed, pendingStopIds: body.pendingStopIds,
        });
      }
      return Response.json({}, { status: 404 });
    });

    const result = await runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    );
    expect(result).toEqual({
      status: 'ok', routeId, routeVersion: 2, executionVersion: 5,
      routeStatus: 'published', stopCount: 2,
      checks: {
        created: true, published: true, loadedBySeller: true,
        composition: 'applied', reasonConfirmed: true, reordered: 'applied',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|client|address|snapshot/i);
    expect(request).toHaveBeenCalledTimes(11);
  });

  it('rejects a manager token without the planning capability', async () => {
    const request = vi.fn(async () => Response.json({
      id: managerId, displayName: 'Gestor A Sintetico', roles: ['manager'],
      capabilities: ['identity.read_self'], scopeIds: [sellerId], status: 'active',
    }));
    await expect(runRouteRoundTrip('http://127.0.0.1:3000', managerToken, sellerToken, request))
      .rejects.toThrow('capacidade');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('recognizes an already revised composition and canonical execution order', async () => {
    const targetOrder = [secondStopId, firstStopId];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const authorization = new Headers(init?.headers).get('authorization');
      const identity = identityResponse(url, authorization);
      if (identity) return identity;
      if (url.pathname === myTodayRoutePath) return Response.json(revisedPublishedTodayRoute(targetOrder, 5));
      if (url.pathname === routeExecutionOrderPath(routeId)) {
        const body = JSON.parse(String(init?.body)) as { pendingStopIds: string[] };
        return Response.json({
          schemaVersion: 1, routeId, routeVersionId: revisedRouteVersionId,
          executionVersion: 5, changed: false, pendingStopIds: body.pendingStopIds,
        });
      }
      return Response.json({}, { status: 404 });
    });

    await expect(runRouteRoundTrip(
      'http://127.0.0.1:3000', managerToken, sellerToken, request,
    )).resolves.toEqual({
      status: 'ok', routeId, routeVersion: 2, executionVersion: 5,
      routeStatus: 'published', stopCount: 2,
      checks: {
        created: true, published: true, loadedBySeller: true,
        composition: 'already_current', reasonConfirmed: true,
        reordered: 'already_canonical',
      },
    });
    expect(request).toHaveBeenCalledTimes(5);
  });
});
