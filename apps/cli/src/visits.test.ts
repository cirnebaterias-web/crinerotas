import { describe, expect, it, vi } from 'vitest';
import { runVisitRoundTrip } from './visits';

const sellerId = '11111111-1111-4111-8111-111111111111';
const stopId = '44444444-4444-4444-8444-444444444444';

describe('visit round-trip CLI', () => {
  it('starts, replays and rejects divergence without returning private payloads', async () => {
    let canonical: Record<string, unknown> | null = null;
    let startCalls = 0;
    let stockCalls = 0;
    let stockCanonical: Record<string, unknown> | null = null;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/v1/me') return Response.json({
        id: sellerId,
        displayName: 'Vendedor Sintético',
        roles: ['seller'],
        capabilities: ['route.read_self', 'visit.start_self'],
        scopeIds: [],
        status: 'active',
      });
      if (path === '/api/v1/me/routes/today') return Response.json({
        schemaVersion: 3,
        availability: 'available',
        route: {
          schemaVersion: 3,
          routeId: '33333333-3333-4333-8333-333333333333',
          routeVersionId: '99999999-9999-4999-8999-999999999999',
          versionNumber: 1,
          serviceDate: '2026-09-17',
          status: 'published',
          publishedAt: '2026-09-17T08:00:00.000Z',
          executionVersion: 1,
          seller: { id: sellerId, displayName: 'Vendedor Sintético' },
          compositionChange: null,
          stops: [{
            routeVersionStopId: stopId,
            plannedOrder: 1,
            executionOrder: 1,
            priority: 1,
            status: 'pending',
            executionVersion: 1,
            client: {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              externalReference: null,
              name: 'Cliente Sintético',
              address: 'Endereço sintético',
              latitude: null,
              longitude: null,
              portfolioReference: null,
            },
          }],
        },
      });
      if (path.endsWith('/sections/stock')) {
        stockCalls += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (stockCalls === 3) return Response.json({
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED', message: 'Chave divergente.', recoverable: false,
            timestamp: '2026-09-17T12:05:02.000Z', requestId: crypto.randomUUID(),
          },
        }, { status: 409 });
        stockCanonical ??= {
          schemaVersion: 1,
          stockSnapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          visitId: '88888888-8888-4888-8888-888888888888',
          offlineId: body.offlineId,
          heliarQuantity: body.heliarQuantity,
          mouraQuantity: body.mouraQuantity,
          serverSavedAt: '2026-09-17T12:05:01.000Z',
        };
        return Response.json(stockCanonical);
      }
      startCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (startCalls === 3) return Response.json({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Chave divergente.',
          recoverable: false,
          timestamp: '2026-09-17T12:00:02.000Z',
          requestId: crypto.randomUUID(),
        },
      }, { status: 409 });
      canonical ??= {
        schemaVersion: 1,
        visitId: '88888888-8888-4888-8888-888888888888',
        offlineId: body.offlineId,
        deviceId: (init?.headers as Record<string, string>)['X-Device-Id'],
        routeVersionStopId: stopId,
        routeVersionId: '99999999-9999-4999-8999-999999999999',
        clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sellerId,
        parameterSetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'in_progress',
        contextSnapshot: {
          schemaVersion: 1,
          sourceRouteVersionId: '99999999-9999-4999-8999-999999999999',
          snapshotCreatedAt: '2026-09-17T12:00:01.000Z',
          route: { id: '33333333-3333-4333-8333-333333333333', versionNumber: 1, serviceDate: '2026-09-17', publishedAt: '2026-09-17T08:00:00.000Z', plannedOrder: 1, priority: 1 },
          client: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', externalReference: null, name: 'Cliente Sintético', address: 'Endereço sintético', latitude: null, longitude: null, portfolioReference: null },
          seller: { id: sellerId, displayName: 'Vendedor Sintético' },
          parameters: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1 },
        },
        deviceStartedAt: body.deviceStartedAt,
        serverStartedAt: '2026-09-17T12:00:01.000Z',
      };
      return Response.json(canonical);
    });

    const result = await runVisitRoundTrip('http://127.0.0.1:3000', 'seller-token', request);
    expect(result.checks).toEqual({
      started: true,
      replayMatched: true,
      divergentRejected: true,
      canonicalContext: true,
      stockSaved: true,
      stockReplayMatched: true,
      stockDivergentRejected: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/token|payload|location|eventId|idempotency/i);
    expect(startCalls).toBe(3);
    expect(stockCalls).toBe(3);
  });
});
