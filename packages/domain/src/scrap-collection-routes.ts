import {
  scrapCollectionRouteCandidateSchema, scrapCollectionRouteSchema,
  type ScrapCollectionRoute,
} from '@cirne/contracts';

export const scrapCollectionRoutePolicy = {
  version: 'scrap-route-proximity-v1' as const,
  method: 'centroid-edge-nearest-neighbor' as const,
  distance: 'haversine_approximation' as const,
};

function distanceKm(left: { latitude: number; longitude: number }, right: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude))
    * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function suggestScrapCollectionRoute(input: {
  routeId: string; routeDate: string; generatedAt: string; candidates: readonly unknown[];
}): ScrapCollectionRoute {
  const candidates = input.candidates.map((candidate) => scrapCollectionRouteCandidateSchema.parse(candidate));
  if (candidates.length === 0) throw new RangeError('A rota precisa de pelo menos uma coleta.');
  if (new Set(candidates.map(({ scheduleId }) => scheduleId)).size !== candidates.length) {
    throw new RangeError('Um agendamento não pode aparecer duas vezes na rota.');
  }
  const located = candidates.filter((candidate) => candidate.location !== null);
  const pending = candidates.filter((candidate) => candidate.location === null)
    .sort((left, right) => left.clientName.localeCompare(right.clientName, 'pt-BR')
      || left.scheduleId.localeCompare(right.scheduleId));
  const ordered: typeof located = [];
  if (located.length > 0) {
    const centroid = { latitude: located.reduce((sum, item) => sum + item.location!.latitude, 0) / located.length,
      longitude: located.reduce((sum, item) => sum + item.location!.longitude, 0) / located.length };
    const remaining = [...located];
    remaining.sort((left, right) => distanceKm(right.location!, centroid) - distanceKm(left.location!, centroid)
      || left.scheduleId.localeCompare(right.scheduleId));
    ordered.push(remaining.shift()!);
    while (remaining.length > 0) {
      const previous = ordered.at(-1)!;
      remaining.sort((left, right) => distanceKm(previous.location!, left.location!)
        - distanceKm(previous.location!, right.location!) || left.scheduleId.localeCompare(right.scheduleId));
      ordered.push(remaining.shift()!);
    }
  }
  const stops = [...ordered, ...pending].map((candidate, index, all) => {
    const previous = all[index - 1];
    const approximate = previous?.location && candidate.location
      ? Math.round(distanceKm(previous.location, candidate.location) * 10) / 10 : null;
    return { ...candidate, suggestedOrder: index + 1, approximateFromPreviousKm: approximate,
      geographyStatus: candidate.location ? 'calculated' as const : 'pending_location' as const, result: null };
  });
  return scrapCollectionRouteSchema.parse({ schemaVersion: 1, routeId: input.routeId, version: 1,
    routeDate: input.routeDate, status: 'draft', operatorId: null, generatedAt: input.generatedAt,
    policy: scrapCollectionRoutePolicy, stops, counts: { total: stops.length, geocoded: located.length,
      pendingLocation: pending.length, completed: 0 } });
}

export function deriveScrapCollectionRouteStatus(
  current: ScrapCollectionRoute['status'],
  results: ReadonlyArray<'collected' | 'not_collected' | null>,
): ScrapCollectionRoute['status'] {
  if (current === 'cancelled') return current;
  if (results.length === 0) throw new RangeError('A rota precisa de paradas.');
  const completed = results.filter((result) => result !== null).length;
  if (completed === results.length) return 'completed';
  if (completed > 0) return 'in_progress';
  return current;
}
