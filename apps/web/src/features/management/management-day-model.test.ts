import { describe, expect, it } from 'vitest';
import type { ManagementDayRouteV2 } from '@cirne/contracts';
import {
  filterManagementRoutes, firstAttentionStop, managementAttentionQueue, resolvedStopCount,
  routeClosureLabel, routeDailyState, routeNeedsAttention,
} from './management-day-model';

function route(overrides: Partial<ManagementDayRouteV2> = {}): ManagementDayRouteV2 {
  return {
    routeId: '10000000-0000-4000-8000-000000000001',
    routeVersionId: '10000000-0000-4000-8000-000000000002', versionNumber: 1,
    seller: { id: '20000000-0000-4000-8000-000000000001', displayName: 'Ana Souza' },
    counts: { planned: 1, pending: 1, inVisit: 0, completed: 0, notVisited: 0 },
    sync: { pending: 0, errors: 0, oldestPendingAt: null, lastKnownAt: null },
    nonVisits: [], historicalExecutions: [], syncIssues: [], visits: [],
    lastKnownUpdateAt: '2026-10-20T11:00:00.000Z',
    stops: [{ routeVersionStopId: '30000000-0000-4000-8000-000000000001', plannedOrder: 1,
      executionOrder: 1, priority: 0,
      client: { id: '40000000-0000-4000-8000-000000000001', name: 'Auto Peças Norte' },
      status: 'pending', nonVisitReason: null, lastKnownUpdateAt: '2026-10-20T11:00:00.000Z', visits: [] }],
    ...overrides,
  };
}

describe('management day model', () => {
  it('classifies a fully resolved route from completed and non-visited stops', () => {
    const value = route({ counts: { planned: 2, pending: 0, inVisit: 0, completed: 1, notVisited: 1 },
      stops: [] });
    expect(resolvedStopCount(value)).toBe(2);
    expect(routeDailyState(value)).toBe('completed');
    expect(routeClosureLabel(value)).toBe('Rota resolvida com 1 não visitada');
  });

  it('marks non-visits and server exceptions for attention', () => {
    const value = route({ stops: [{ ...route().stops[0]!, status: 'not_visited',
      nonVisitReason: { id: '50000000-0000-4000-8000-000000000001', label: 'Cliente fechado' } }] });
    expect(routeNeedsAttention(value)).toBe(true);
    expect(routeDailyState(value)).toBe('attention_required');
  });

  it('filters locally by seller, client and attention without another request', () => {
    const normal = route();
    const attention = route({ routeId: '10000000-0000-4000-8000-000000000003', seller: {
      id: '20000000-0000-4000-8000-000000000002', displayName: 'Bruno Lima' },
      stops: [{ ...route().stops[0]!, status: 'not_visited', client: {
        id: '40000000-0000-4000-8000-000000000002', name: 'Baterias Sul' },
        nonVisitReason: { id: '50000000-0000-4000-8000-000000000001', label: 'Cliente fechado' } }] });
    expect(filterManagementRoutes([normal, attention], 'auto peças', false)).toEqual([normal]);
    expect(filterManagementRoutes([normal, attention], '', true)).toEqual([attention]);
  });

  it('opens a route-level synchronization error even when no stop has an exception', () => {
    const value = route({ sync: { pending: 0, errors: 1, oldestPendingAt: null, lastKnownAt: '2026-10-20T11:00:00.000Z' } });
    expect(firstAttentionStop([value])).toEqual({ routeId: value.routeId, stopId: value.stops[0]?.routeVersionStopId });
    expect(managementAttentionQueue([value])).toMatchObject([{
      routeId: value.routeId, clientName: 'Rota inteira', reason: '1 erro de sincronização',
    }]);
  });

  it('orders action-required activity before in-progress and non-visited stops', () => {
    const baseStop = route().stops[0]!;
    const value = route({ counts: { planned: 3, pending: 0, inVisit: 1, completed: 1, notVisited: 1 }, stops: [
      { ...baseStop, status: 'in_visit', client: { ...baseStop.client, name: 'Em andamento' } },
      { ...baseStop, routeVersionStopId: '30000000-0000-4000-8000-000000000002', status: 'completed',
        client: { ...baseStop.client, name: 'Ação' }, visits: [{
          visitId: '50000000-0000-4000-8000-000000000001', routeVersionStopId: '30000000-0000-4000-8000-000000000002',
          client: { ...baseStop.client, name: 'Ação' }, status: 'completed',
          deviceStartedAt: baseStop.lastKnownUpdateAt, serverStartedAt: baseStop.lastKnownUpdateAt,
          lastKnownUpdateAt: baseStop.lastKnownUpdateAt, exceptionCount: 0,
          checklist: { facadeCheckin: 'confirmed', checkout: 'confirmed', stock: 'action_required',
            competitorPrices: 'confirmed', commercialActions: 'confirmed', scrap: 'confirmed',
            result: 'confirmed', synchronization: 'confirmed' },
        }] },
      { ...baseStop, routeVersionStopId: '30000000-0000-4000-8000-000000000003', status: 'not_visited',
        client: { ...baseStop.client, name: 'Não visitada' } },
    ] });
    expect(managementAttentionQueue([value]).map(({ reason }) => reason)).toEqual([
      'Atividade exige ação', 'Visita em andamento', 'Loja não visitada',
    ]);
  });

  it('distinguishes all visited, open and incomplete daily closure labels', () => {
    expect(routeClosureLabel(route({ counts: { planned: 1, pending: 0, inVisit: 0, completed: 1, notVisited: 0 } })))
      .toBe('Todas as lojas visitadas');
    expect(routeClosureLabel(route())).toBe('Rota ainda aberta');
    expect(routeClosureLabel(route({ lastKnownUpdateAt: null }))).toBe('Dados incompletos/sem atualização');
  });
});
