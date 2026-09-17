import type { CanonicalRoute } from '@cirne/contracts';

type Stop = CanonicalRoute['stops'][number];
export function orderedStops(stops: Stop[]) { return [...stops].sort((a, b) => a.executionOrder - b.executionOrder); }
export function pendingIds(stops: Stop[]) {
  return orderedStops(stops).filter((stop) => stop.status === 'pending').map((stop) => stop.routeVersionStopId);
}
export function movePending(stops: Stop[], stopId: string, direction: -1 | 1): Stop[] {
  const sorted = orderedStops(stops);
  const pending = sorted.filter((stop) => stop.status === 'pending');
  const from = pending.findIndex((stop) => stop.routeVersionStopId === stopId);
  const target = from + direction;
  if (from < 0 || target < 0 || target >= pending.length) return sorted;
  [pending[from], pending[target]] = [pending[target]!, pending[from]!];
  let index = 0;
  return sorted.map((stop) => stop.status === 'pending'
    ? { ...pending[index++]!, executionOrder: stop.executionOrder } : stop);
}
export function routeProgress(stops: Stop[]) {
  const completed = stops.filter((stop) => stop.status === 'completed').length;
  return { completed, total: stops.length, percent: stops.length ? Math.round(completed * 100 / stops.length) : 0 };
}
export function formatServiceDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
