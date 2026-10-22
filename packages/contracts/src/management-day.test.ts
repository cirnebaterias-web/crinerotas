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
});
