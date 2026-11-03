import { describe, expect, it } from 'vitest';
import { managementDayResponseSchema, managementServiceDateSchema } from './management-day';

const empty = {
  schemaVersion: 1,
  serviceDate: '2026-10-20',
  generatedAt: '2026-10-20T12:00:00.000Z',
  lastKnownUpdateAt: null,
  availability: 'empty',
  totals: { planned: 0, pending: 0, inVisit: 0, completed: 0, notVisited: 0 },
  sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
  routes: [],
  serverVisibilityNote: 'Somente eventos recebidos pelo servidor estão incluídos; itens ainda apenas no aparelho não são visíveis.',
} as const;

describe('management day contract', () => {
  it('accepts a reconciled empty view and rejects impossible dates', () => {
    expect(managementDayResponseSchema.parse(empty)).toEqual(empty);
    expect(managementServiceDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(managementServiceDateSchema.safeParse('20/10/2026').success).toBe(false);
  });

  it('rejects totals that do not reconcile with route states', () => {
    const invalid = {
      ...empty,
      availability: 'available',
      totals: { planned: 2, pending: 2, inVisit: 0, completed: 0, notVisited: 0 },
      routes: [{
        routeId: '10000000-0000-4000-8000-000000000001',
        routeVersionId: '10000000-0000-4000-8000-000000000002',
        versionNumber: 1,
        seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor A' },
        counts: { planned: 1, pending: 1, inVisit: 0, completed: 0, notVisited: 0 },
        sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
        nonVisits: [], historicalExecutions: [], syncIssues: [], lastKnownUpdateAt: null,
      }],
    };
    expect(managementDayResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it('does not accept payload, coordinates, photos or tokens in strict issue rows', () => {
    const route = {
      routeId: '10000000-0000-4000-8000-000000000001',
      routeVersionId: '10000000-0000-4000-8000-000000000002', versionNumber: 1,
      seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor A' },
      counts: { planned: 1, pending: 1, inVisit: 0, completed: 0, notVisited: 0 },
      sync: { pending: 1, errors: 0, oldestPendingAt: '2026-10-20T11:00:00.000Z', lastKnownAt: '2026-10-20T11:05:00.000Z' },
      nonVisits: [], historicalExecutions: [], lastKnownUpdateAt: '2026-10-20T11:05:00.000Z',
      syncIssues: [{ eventId: '30000000-0000-4000-8000-000000000001', status: 'recoverable_error',
        errorCode: 'DEPENDENCY_UNAVAILABLE', occurredAt: '2026-10-20T11:00:00.000Z',
        lastObservedAt: '2026-10-20T11:05:00.000Z', payload: { token: 'secret', latitude: -5 } }],
    };
    expect(managementDayResponseSchema.safeParse({ ...empty, availability: 'available',
      totals: route.counts, sync: route.sync, routes: [route], lastKnownUpdateAt: route.lastKnownUpdateAt }).success)
      .toBe(false);
  });

  it('accepts the v2 stop checklist while keeping the v1 document compatible', () => {
    expect(managementDayResponseSchema.safeParse(empty).success).toBe(true);
    const stop = {
      routeVersionStopId: '30000000-0000-4000-8000-000000000001',
      plannedOrder: 1, executionOrder: 1, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Cliente A' },
      status: 'pending' as const, nonVisitReason: null,
      lastKnownUpdateAt: '2026-10-20T11:05:00.000Z', visits: [],
    };
    const route = {
      routeId: '10000000-0000-4000-8000-000000000001',
      routeVersionId: '10000000-0000-4000-8000-000000000002', versionNumber: 1,
      seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor A' },
      counts: { planned: 1, pending: 1, inVisit: 0, completed: 0, notVisited: 0 },
      sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
      nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [],
      lastKnownUpdateAt: stop.lastKnownUpdateAt, stops: [stop],
    };
    const parsed = managementDayResponseSchema.safeParse({
      ...empty, schemaVersion: 2, availability: 'available', totals: route.counts,
      routes: [route], lastKnownUpdateAt: route.lastKnownUpdateAt,
    });
    expect(parsed.success).toBe(true);
    const inconsistentCounts = { planned: 1, pending: 0, inVisit: 0, completed: 1, notVisited: 0 };
    expect(managementDayResponseSchema.safeParse({
      ...empty, schemaVersion: 2, availability: 'available', totals: inconsistentCounts,
      routes: [{ ...route, counts: inconsistentCounts }], lastKnownUpdateAt: route.lastKnownUpdateAt,
    }).success).toBe(false);
    const duplicateCounts = { planned: 2, pending: 2, inVisit: 0, completed: 0, notVisited: 0 };
    expect(managementDayResponseSchema.safeParse({
      ...empty, schemaVersion: 2, availability: 'available', totals: duplicateCounts,
      routes: [{ ...route, counts: duplicateCounts, stops: [stop, { ...stop }] }],
      lastKnownUpdateAt: route.lastKnownUpdateAt,
    }).success).toBe(false);
    const completedCounts = { planned: 1, pending: 0, inVisit: 0, completed: 1, notVisited: 0 };
    const mismatchedVisit = {
      visitId: '50000000-0000-4000-8000-000000000001',
      routeVersionStopId: '30000000-0000-4000-8000-000000000099', client: stop.client,
      status: 'completed' as const, deviceStartedAt: stop.lastKnownUpdateAt,
      serverStartedAt: stop.lastKnownUpdateAt, lastKnownUpdateAt: stop.lastKnownUpdateAt,
      exceptionCount: 0, checklist: { facadeCheckin: 'confirmed', checkout: 'confirmed', stock: 'confirmed',
        competitorPrices: 'confirmed', commercialActions: 'confirmed', scrap: 'confirmed',
        result: 'confirmed', synchronization: 'confirmed' } as const,
    };
    expect(managementDayResponseSchema.safeParse({
      ...empty, schemaVersion: 2, availability: 'available', totals: completedCounts,
      routes: [{ ...route, counts: completedCounts, stops: [{ ...stop, status: 'completed', visits: [mismatchedVisit] }] }],
      lastKnownUpdateAt: route.lastKnownUpdateAt,
    }).success).toBe(false);
  });

  it('rejects sensitive fields inside v2 checklist summaries', () => {
    const checklist = {
      facadeCheckin: 'confirmed', checkout: 'confirmed', stock: 'confirmed',
      competitorPrices: 'confirmed', commercialActions: 'confirmed', scrap: 'confirmed',
      result: 'confirmed', synchronization: 'confirmed',
    } as const;
    const visit = {
      visitId: '50000000-0000-4000-8000-000000000001',
      routeVersionStopId: '30000000-0000-4000-8000-000000000001',
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Cliente A' },
      status: 'completed' as const, deviceStartedAt: '2026-10-20T10:00:00.000Z',
      serverStartedAt: '2026-10-20T10:00:01.000Z', lastKnownUpdateAt: '2026-10-20T11:00:00.000Z',
      exceptionCount: 0, checklist, latitude: '-5.0', photoUrl: 'https://invalid.example/photo.jpg',
    };
    const route = {
      routeId: '10000000-0000-4000-8000-000000000001',
      routeVersionId: '10000000-0000-4000-8000-000000000002', versionNumber: 1,
      seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Vendedor A' },
      counts: { planned: 1, pending: 0, inVisit: 0, completed: 1, notVisited: 0 },
      sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
      nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [],
      lastKnownUpdateAt: visit.lastKnownUpdateAt,
      stops: [{ routeVersionStopId: visit.routeVersionStopId, plannedOrder: 1, executionOrder: 1,
        priority: 0, client: visit.client, status: 'completed', nonVisitReason: null,
        lastKnownUpdateAt: visit.lastKnownUpdateAt, visits: [visit] }],
    };
    expect(managementDayResponseSchema.safeParse({
      ...empty, schemaVersion: 2, availability: 'available', totals: route.counts,
      routes: [route], lastKnownUpdateAt: route.lastKnownUpdateAt,
    }).success).toBe(false);
  });
});
