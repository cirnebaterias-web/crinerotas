import type { ManagementDayRouteV2, ManagementDayStop } from '@cirne/contracts';

export type RouteDailyState = 'completed' | 'in_progress' | 'not_started' | 'attention_required';

export type ManagementAttentionItem = {
  id: string;
  routeId: string;
  stopId: string;
  sellerName: string;
  clientName: string;
  reason: string;
  priority: number;
};

export function resolvedStopCount(route: ManagementDayRouteV2) {
  return route.counts.completed + route.counts.notVisited;
}

export function stopNeedsAttention(stop: ManagementDayStop) {
  if (stop.status === 'not_visited') return true;
  if (stop.status === 'in_visit') return true;
  return stop.visits.some((visit) => (
    visit.exceptionCount > 0
    || Object.values(visit.checklist).some((state) => (
      state === 'action_required' || state === 'exception' || state === 'unknown_to_server'
    ))
  ));
}

export function routeDailyState(route: ManagementDayRouteV2): RouteDailyState {
  if (route.sync.errors > 0 || route.stops.some(stopNeedsAttention)) return 'attention_required';
  if (resolvedStopCount(route) === route.counts.planned) return 'completed';
  if (route.counts.inVisit > 0 || route.counts.completed > 0 || route.counts.notVisited > 0) return 'in_progress';
  return 'not_started';
}

export function routeNeedsAttention(route: ManagementDayRouteV2) {
  return route.sync.errors > 0 || route.sync.pending > 0 || route.stops.some(stopNeedsAttention);
}

export function routeClosureLabel(route: ManagementDayRouteV2) {
  if (!route.lastKnownUpdateAt) return 'Dados incompletos/sem atualização';
  if (route.counts.completed === route.counts.planned) return 'Todas as lojas visitadas';
  if (route.counts.pending === 0 && route.counts.inVisit === 0 && route.counts.notVisited > 0
      && resolvedStopCount(route) === route.counts.planned) {
    return `Rota resolvida com ${route.counts.notVisited} não visitada${route.counts.notVisited === 1 ? '' : 's'}`;
  }
  return 'Rota ainda aberta';
}

export function filterManagementRoutes(routes: ManagementDayRouteV2[], query: string, onlyAttention: boolean) {
  const normalized = query.trim().toLocaleLowerCase('pt-BR');
  return routes.filter((route) => {
    if (onlyAttention && !routeNeedsAttention(route)) return false;
    if (!normalized) return true;
    return route.seller.displayName.toLocaleLowerCase('pt-BR').includes(normalized)
      || route.stops.some((stop) => stop.client.name.toLocaleLowerCase('pt-BR').includes(normalized));
  });
}

function stopAttention(stop: ManagementDayStop) {
  const states = stop.visits.flatMap((visit) => Object.values(visit.checklist));
  if (states.includes('action_required')) return { priority: 0, reason: 'Atividade exige ação' };
  if (stop.status === 'in_visit') return { priority: 2, reason: 'Visita em andamento' };
  if (stop.status === 'not_visited') return { priority: 3, reason: 'Loja não visitada' };
  if (states.includes('exception')) return { priority: 4, reason: 'Visita com exceção' };
  if (states.includes('unknown_to_server')) return { priority: 5, reason: 'Atividade ainda não recebida' };
  return null;
}

export function managementAttentionQueue(routes: ManagementDayRouteV2[]): ManagementAttentionItem[] {
  const items = routes.flatMap((route) => {
    const firstStop = route.stops[0];
    const routeItems: ManagementAttentionItem[] = [];
    if (firstStop && route.sync.errors > 0) {
      routeItems.push({
        id: `${route.routeId}:sync-error`, routeId: route.routeId, stopId: firstStop.routeVersionStopId,
        sellerName: route.seller.displayName, clientName: 'Rota inteira', priority: 0,
        reason: `${route.sync.errors} erro${route.sync.errors === 1 ? '' : 's'} de sincronização`,
      });
    } else if (firstStop && route.sync.pending > 0) {
      routeItems.push({
        id: `${route.routeId}:sync-pending`, routeId: route.routeId, stopId: firstStop.routeVersionStopId,
        sellerName: route.seller.displayName, clientName: 'Rota inteira', priority: 1,
        reason: `${route.sync.pending} envio${route.sync.pending === 1 ? '' : 's'} pendente${route.sync.pending === 1 ? '' : 's'}`,
      });
    }
    for (const stop of route.stops) {
      const attention = stopAttention(stop);
      if (!attention) continue;
      routeItems.push({
        id: `${route.routeId}:${stop.routeVersionStopId}`, routeId: route.routeId,
        stopId: stop.routeVersionStopId, sellerName: route.seller.displayName,
        clientName: stop.client.name, reason: attention.reason, priority: attention.priority,
      });
    }
    return routeItems;
  });
  return items.sort((left, right) => left.priority - right.priority
    || left.sellerName.localeCompare(right.sellerName, 'pt-BR')
    || left.clientName.localeCompare(right.clientName, 'pt-BR')
    || left.id.localeCompare(right.id));
}

export function firstAttentionStop(routes: ManagementDayRouteV2[]) {
  const first = managementAttentionQueue(routes)[0];
  return first ? { routeId: first.routeId, stopId: first.stopId } : null;
}
