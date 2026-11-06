import {
  weeklyRouteBaseCityOriginSchema, weeklyRouteCandidateSchema, weeklyRoutePolicySchema,
  weeklyRouteProposalSchema, type WeeklyRouteCandidate, type WeeklyRouteProposal,
} from '@cirne/contracts';

export const weeklyRoutePolicy = weeklyRoutePolicySchema.parse({
  version: 'weekly-route-rules-v2', inactiveAfterDays: 180, dailyClientLimit: 10,
  dailyGpsMaxAgeMinutes: 5, dailyGpsMaxAccuracyM: 100,
  weights: { recency: 50, volume: 15, scrapDebt: 20, proximity: 15 },
});

function dayNumber(date: string) {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(value)) throw new RangeError('Data inválida.');
  return Math.floor(value / 86_400_000);
}

function shiftDate(date: string, days: number) {
  return new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

function distanceKm(origin: { latitude: number; longitude: number }, target: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const deltaLatitude = radians(target.latitude - origin.latitude);
  const deltaLongitude = radians(target.longitude - origin.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(origin.latitude))
    * Math.cos(radians(target.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreCandidate(candidate: WeeklyRouteCandidate, origin: { latitude: number; longitude: number }) {
  const days = candidate.daysSinceLastPurchase!;
  const recencyBasis = candidate.periodicityDays ? days / candidate.periodicityDays : days / weeklyRoutePolicy.inactiveAfterDays;
  const recency = Math.min(1, Math.max(0, recencyBasis)) * weeklyRoutePolicy.weights.recency;
  const volume = candidate.averageMonthlyVolume === null ? null
    : Math.min(1, Math.log1p(candidate.averageMonthlyVolume) / Math.log(1001)) * weeklyRoutePolicy.weights.volume;
  const scrap = candidate.scrapDebtKg === null ? null
    : Math.min(1, candidate.scrapDebtKg / 1000) * weeklyRoutePolicy.weights.scrapDebt;
  const distance = candidate.location ? distanceKm(origin, candidate.location) : null;
  const proximity = distance === null ? 0 : Math.max(0, 1 - distance / 200) * weeklyRoutePolicy.weights.proximity;
  return { score: Math.round(([recency, volume, scrap, proximity].reduce<number>((sum, value) =>
    value === null ? sum : sum + value, 0)) * 100) / 100,
    distance: distance === null ? null : Math.round(distance * 10) / 10 };
}

export function proposeWeeklyRoutes(input: {
  weekStart: string; generatedAt: string; origin: unknown; candidates: readonly unknown[];
  sources?: unknown;
}): WeeklyRouteProposal {
  const weekStart = input.weekStart;
  if (dayNumber(weekStart) % 7 !== 4) throw new RangeError('A semana deve iniciar em uma segunda-feira.');
  const origin = weeklyRouteBaseCityOriginSchema.parse(input.origin);
  const generatedAt = Date.parse(input.generatedAt);
  if (!Number.isFinite(generatedAt)) throw new RangeError('Instante de geração inválido.');
  const candidates = input.candidates.map((candidate) => weeklyRouteCandidateSchema.parse(candidate));
  if (new Set(candidates.map(({ clientId }) => clientId)).size !== candidates.length) throw new RangeError('Cliente repetido.');

  const excluded: Array<{ clientId: string; reason: 'inactive_lost' | 'no_purchase_history' | 'client_not_active' | 'no_navigable_location' }> = [];
  const eligible = candidates.flatMap((candidate) => {
    if (candidate.status !== 'active') { excluded.push({ clientId: candidate.clientId, reason: 'client_not_active' }); return []; }
    if (candidate.daysSinceLastPurchase === null) { excluded.push({ clientId: candidate.clientId, reason: 'no_purchase_history' }); return []; }
    if (candidate.daysSinceLastPurchase > weeklyRoutePolicy.inactiveAfterDays) {
      excluded.push({ clientId: candidate.clientId, reason: 'inactive_lost' }); return [];
    }
    if (!candidate.location && !candidate.hasNavigableAddress) {
      excluded.push({ clientId: candidate.clientId, reason: 'no_navigable_location' }); return [];
    }
    return [{ candidate, ...scoreCandidate(candidate, origin) }];
  }).sort((left, right) => right.score - left.score
    || (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER)
    || left.candidate.clientId.localeCompare(right.candidate.clientId));

  const days = Array.from({ length: 5 }, (_, dayIndex) => ({ dayIndex, serviceDate: shiftDate(weekStart, dayIndex), suggestions: [] as WeeklyRouteProposal['days'][number]['suggestions'] }));
  eligible.slice(0, 50).forEach(({ candidate, score, distance }, index) => {
    const dayIndex = Math.floor(index / weeklyRoutePolicy.dailyClientLimit);
    const reasons = [`${candidate.daysSinceLastPurchase} dias desde a última compra`];
    if (candidate.periodicityDays) reasons.push(`ciclo observado de ${Math.round(candidate.periodicityDays)} dias`);
    else reasons.push('periodicidade indisponível');
    if (candidate.averageMonthlyVolume === null) reasons.push('volume médio indisponível');
    if ((candidate.scrapDebtKg ?? 0) > 0) reasons.push(`${Math.round(candidate.scrapDebtKg!)} kg de débito de sucata`);
    else if (candidate.scrapBalanceState === 'creditor') reasons.push('saldo de sucata credor');
    else if (candidate.scrapBalanceState === 'settled') reasons.push('saldo de sucata quitado');
    else if (candidate.scrapBalanceState === 'unavailable') reasons.push('saldo de sucata indisponível');
    if (distance !== null) reasons.push(`${distance.toLocaleString('pt-BR')} km aproximados da origem`);
    else reasons.push('destino navegável sem distância calculável');
    days[dayIndex]!.suggestions.push({ clientId: candidate.clientId, name: candidate.name,
      dayIndex, plannedOrder: days[dayIndex]!.suggestions.length + 1, score,
      approximateDistanceKm: distance, reasons, locationPending: candidate.location === null,
      scrapBalanceState: candidate.scrapBalanceState });
  });
  return weeklyRouteProposalSchema.parse({ schemaVersion: 1, mode: 'rules', weekStart,
    sellerId: origin.sellerId, generatedAt: input.generatedAt, policy: weeklyRoutePolicy, origin,
    sources: input.sources ?? { sales: { status: 'unavailable', generationId: null, asOfDate: null },
      scrap: { status: 'unavailable', generationId: null, publishedAt: null } },
    days, excluded, counts: { evaluated: candidates.length, suggested: Math.min(eligible.length, 50),
      inactiveLost: excluded.filter(({ reason }) => reason === 'inactive_lost').length,
      noPurchaseHistory: excluded.filter(({ reason }) => reason === 'no_purchase_history').length,
      needsReview: excluded.filter(({ reason }) => reason === 'client_not_active' || reason === 'no_navigable_location').length } });
}
