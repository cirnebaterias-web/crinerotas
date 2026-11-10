import {
  currentWeeklyRoutePolicySchema, weeklyRouteBaseCityOriginSchema, weeklyRouteCandidateSchema,
  weeklyRouteProposalSchema, type WeeklyRouteCandidate, type WeeklyRouteExclusionReason,
  type WeeklyRouteProposal,
} from '@cirne/contracts';

export const maxDailyLegDistanceKm = 30 as const;
export const tripFromBaseDistanceKm = 80 as const;
export const coverageCadenceDays = 28 as const;

export const weeklyRoutePolicy = currentWeeklyRoutePolicySchema.parse({
  version: 'weekly-route-rules-v3', inactiveAfterDays: 180, dailyClientLimit: 10,
  dailyGpsMaxAgeMinutes: 5, dailyGpsMaxAccuracyM: 100,
  coverageCadenceDays, tripFromBaseDistanceKm,
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

function saoPauloDate(instant: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function analyzeVisitCoverage(candidate: WeeklyRouteCandidate, weekStart: string) {
  if (candidate.visitHistoryStatus === 'unavailable') return {
    coverageState: 'unavailable' as const, coverageOverdueDays: null, nextVisitDueOn: null,
  };
  if (candidate.lastCompletedVisitAt === null) return {
    coverageState: 'never_visited' as const, coverageOverdueDays: null, nextVisitDueOn: null,
  };
  const nextVisitDueOn = shiftDate(saoPauloDate(candidate.lastCompletedVisitAt), coverageCadenceDays);
  const overdueDays = dayNumber(weekStart) - dayNumber(nextVisitDueOn);
  if (overdueDays > 0) return {
    coverageState: 'overdue' as const, coverageOverdueDays: overdueDays, nextVisitDueOn,
  };
  if (dayNumber(nextVisitDueOn) <= dayNumber(shiftDate(weekStart, 4))) return {
    coverageState: 'due_this_week' as const, coverageOverdueDays: 0, nextVisitDueOn,
  };
  return { coverageState: 'covered' as const, coverageOverdueDays: 0, nextVisitDueOn };
}

export function approximateDistanceKm(origin: { latitude: number; longitude: number }, target: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const deltaLatitude = radians(target.latitude - origin.latitude);
  const deltaLongitude = radians(target.longitude - origin.longitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(origin.latitude))
    * Math.cos(radians(target.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function analyzeWeeklyRouteCandidate(candidate: WeeklyRouteCandidate,
  origin: { latitude: number; longitude: number }, weekStart?: string) {
  const days = candidate.daysSinceLastPurchase!;
  const recencyBasis = candidate.periodicityDays ? days / candidate.periodicityDays : days / weeklyRoutePolicy.inactiveAfterDays;
  const recency = Math.min(1, Math.max(0, recencyBasis)) * weeklyRoutePolicy.weights.recency;
  const volume = candidate.averageMonthlyVolume === null ? null
    : Math.min(1, Math.log1p(candidate.averageMonthlyVolume) / Math.log(1001)) * weeklyRoutePolicy.weights.volume;
  const scrap = candidate.scrapDebtKg === null ? null
    : Math.min(1, candidate.scrapDebtKg / 1000) * weeklyRoutePolicy.weights.scrapDebt;
  const recent = candidate.recentVolume3;
  const previous = candidate.previousVolume3;
  const declineRatio = recent !== null && previous !== null && previous > 0 ? Math.max(0, (previous - recent) / previous) : 0;
  const commercialVolume = volume === null ? null : Math.min(weeklyRoutePolicy.weights.volume,
    volume + declineRatio * weeklyRoutePolicy.weights.volume * 0.6);
  const distance = candidate.location ? approximateDistanceKm(origin, candidate.location) : null;
  const proximity = distance === null ? 0 : Math.max(0, 1 - distance / 200) * weeklyRoutePolicy.weights.proximity;
  const cycleDelayDays = candidate.periodicityDays ? Math.max(0, days - candidate.periodicityDays) : null;
  const cycleDelayPercent = candidate.periodicityDays ? Math.max(0, cycleDelayDays! / candidate.periodicityDays * 100) : null;
  const purchaseTrend = recent === null || previous === null ? 'unavailable' as const
    : recent < previous * 0.9 ? 'falling' as const : recent > previous * 1.1 ? 'growing' as const : 'stable' as const;
  const potential = (candidate.averageMonthlyVolume ?? 0) >= 100 || declineRatio >= 0.3 ? 'high' as const
    : (candidate.averageMonthlyVolume ?? 0) >= 30 || declineRatio >= 0.15 ? 'medium' as const : 'standard' as const;
  const reasons = [`${candidate.daysSinceLastPurchase} dias desde a última compra`];
  if (candidate.periodicityDays) reasons.push(cycleDelayDays! > 0
    ? `${Math.round(cycleDelayDays!)} dias além do ciclo (${Math.round(cycleDelayPercent!)}% de atraso)`
    : `dentro do ciclo de ${Math.round(candidate.periodicityDays)} dias`);
  else reasons.push('periodicidade indisponível');
  if (purchaseTrend === 'falling') reasons.push(`volume recente caiu ${Math.round(declineRatio * 100)}%`);
  else if ((candidate.averageMonthlyVolume ?? 0) > 0) reasons.push(`média de ${Math.round(candidate.averageMonthlyVolume!)} unidades/mês`);
  if ((candidate.scrapDebtKg ?? 0) > 0) reasons.push(`${Math.round(candidate.scrapDebtKg!)} kg de débito de sucata`);
  else if (candidate.scrapBalanceState === 'creditor') reasons.push('saldo de sucata credor');
  else if (candidate.scrapBalanceState === 'settled') reasons.push('saldo de sucata quitado');
  else reasons.push('saldo de sucata indisponível');
  if (distance === null) reasons.push('destino navegável sem distância calculável');
  else reasons.push(`${Math.round(distance * 10) / 10} km aproximados da origem`);
  const coverage = analyzeVisitCoverage(candidate, weekStart ?? saoPauloDate(new Date().toISOString()));
  if (coverage.coverageState === 'unavailable') reasons.unshift('histórico de visitas indisponível');
  else if (coverage.coverageState === 'never_visited') reasons.unshift('sem visita concluída registrada');
  else if (coverage.coverageState === 'overdue') reasons.unshift(
    `${coverage.coverageOverdueDays} dias além da rotina de visita de ${coverageCadenceDays} dias`);
  else if (coverage.coverageState === 'due_this_week') reasons.unshift('visita de rotina vence nesta semana');
  else reasons.unshift(`rotina de visita coberta até ${coverage.nextVisitDueOn}`);
  return { score: Math.round(([recency, commercialVolume, scrap, proximity].reduce<number>((sum, value) =>
    value === null ? sum : sum + value, 0)) * 100) / 100,
    distance: distance === null ? null : Math.round(distance * 10) / 10,
    cycleDelayDays, cycleDelayPercent, purchaseTrend, potential, ...coverage, reasons: reasons.slice(0, 8) };
}

export function classifyDailyRoute(origin: { latitude: number; longitude: number },
  locations: Array<{ latitude: number; longitude: number }>) {
  if (locations.length === 0) return 'local' as const;
  return locations.some((location) => approximateDistanceKm(origin, location) >= tripFromBaseDistanceKm)
    ? 'trip' as const : 'local' as const;
}

export function pointInPolygon(point: { latitude: number; longitude: number },
  polygon: Array<{ latitude: number; longitude: number }>) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    const intersects = ((a.latitude > point.latitude) !== (b.latitude > point.latitude))
      && point.longitude < (b.longitude - a.longitude) * (point.latitude - a.latitude)
        / (b.latitude - a.latitude) + a.longitude;
    if (intersects) inside = !inside;
  }
  return inside;
}

function previousLocatedStop(suggestions: Array<{ candidate: WeeklyRouteCandidate }>) {
  for (let index = suggestions.length - 1; index >= 0; index -= 1) {
    const location = suggestions[index]!.candidate.location;
    if (location) return location;
  }
  return null;
}

function compatibleWithDay(candidate: WeeklyRouteCandidate,
  suggestions: Array<{ candidate: WeeklyRouteCandidate }>) {
  if (!candidate.location || suggestions.length === 0) return true;
  const previous = previousLocatedStop(suggestions);
  return !previous || approximateDistanceKm(previous, candidate.location) <= maxDailyLegDistanceKm;
}

const coverageRank = { overdue: 0, never_visited: 1, due_this_week: 2,
  covered: 3, unavailable: 4 } as const;

function isCoverageDue(state: keyof typeof coverageRank) {
  return state === 'overdue' || state === 'never_visited' || state === 'due_this_week';
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

  const excluded: Array<{ clientId: string; reason: WeeklyRouteExclusionReason }> = [];
  const eligible = candidates.flatMap((candidate) => {
    if (candidate.status !== 'active') { excluded.push({ clientId: candidate.clientId, reason: 'client_not_active' }); return []; }
    if (candidate.daysSinceLastPurchase === null) { excluded.push({ clientId: candidate.clientId, reason: 'no_purchase_history' }); return []; }
    if (candidate.daysSinceLastPurchase > weeklyRoutePolicy.inactiveAfterDays) {
      excluded.push({ clientId: candidate.clientId, reason: 'inactive_lost' }); return [];
    }
    if (!candidate.location && !candidate.hasNavigableAddress) {
      excluded.push({ clientId: candidate.clientId, reason: 'no_navigable_location' }); return [];
    }
    return [{ candidate, ...analyzeWeeklyRouteCandidate(candidate, origin, weekStart) }];
  }).sort((left, right) => coverageRank[left.coverageState] - coverageRank[right.coverageState]
    || (right.coverageOverdueDays ?? 0) - (left.coverageOverdueDays ?? 0)
    || right.score - left.score
    || (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER)
    || left.candidate.clientId.localeCompare(right.candidate.clientId));

  const anchor = eligible.find(({ candidate }) => candidate.location !== null);
  const strategyKind = !anchor ? 'pending' as const
    : anchor.distance !== null && anchor.distance >= tripFromBaseDistanceKm ? 'trip' as const : 'local' as const;
  const strategyEligible = eligible.filter((entry) => {
    if (strategyKind === 'pending' || entry.candidate.location === null) return true;
    if (strategyKind === 'local') return entry.distance !== null && entry.distance < tripFromBaseDistanceKm;
    return entry.distance !== null && entry.distance >= tripFromBaseDistanceKm
      && anchor?.candidate.location !== null
      && approximateDistanceKm(anchor!.candidate.location!, entry.candidate.location) <= maxDailyLegDistanceKm;
  });
  const strategyEligibleIds = new Set(strategyEligible.map(({ candidate }) => candidate.clientId));
  eligible.forEach(({ candidate }) => {
    if (!strategyEligibleIds.has(candidate.clientId)) excluded.push({ clientId: candidate.clientId,
      reason: 'weekly_strategy_mismatch' });
  });

  const workingDays = Array.from({ length: 5 }, () => [] as Array<typeof strategyEligible[number]>);
  strategyEligible.forEach((entry) => {
    const compatible = workingDays.map((suggestions, dayIndex) => ({ suggestions, dayIndex,
      distance: entry.candidate.location && previousLocatedStop(suggestions)
        ? approximateDistanceKm(previousLocatedStop(suggestions)!, entry.candidate.location) : 0 }))
      .filter(({ suggestions }) => suggestions.length < weeklyRoutePolicy.dailyClientLimit
        && compatibleWithDay(entry.candidate, suggestions))
      .sort((left, right) => (left.suggestions.length === 0 ? 1 : 0) - (right.suggestions.length === 0 ? 1 : 0)
        || left.distance - right.distance || left.dayIndex - right.dayIndex)[0];
    if (compatible) compatible.suggestions.push(entry);
    else excluded.push({ clientId: entry.candidate.clientId,
      reason: workingDays.every((suggestions) => suggestions.length >= weeklyRoutePolicy.dailyClientLimit)
        ? 'daily_capacity_reached' : 'daily_distance_limit' });
  });
  const days = workingDays.map((entries, dayIndex) => ({ dayIndex, serviceDate: shiftDate(weekStart, dayIndex),
    suggestions: entries.map(({ candidate, score, distance, reasons, coverageState, coverageOverdueDays,
      nextVisitDueOn }, index) => ({ clientId: candidate.clientId, name: candidate.name,
      dayIndex, plannedOrder: index + 1, score,
      approximateDistanceKm: distance, reasons, locationPending: candidate.location === null,
      scrapBalanceState: candidate.scrapBalanceState, lastCompletedVisitAt: candidate.lastCompletedVisitAt,
      coverageState, coverageOverdueDays, nextVisitDueOn })) }));
  const suggested = days.flatMap(({ suggestions }) => suggestions);
  const coverageDue = eligible.filter(({ coverageState }) => isCoverageDue(coverageState)).length;
  const coveragePlanned = suggested.filter(({ coverageState }) => isCoverageDue(coverageState)).length;
  return weeklyRouteProposalSchema.parse({ schemaVersion: 1, mode: 'rules', weekStart,
    sellerId: origin.sellerId, generatedAt: input.generatedAt, policy: weeklyRoutePolicy, origin,
    sources: input.sources ?? { sales: { status: 'unavailable', generationId: null, asOfDate: null },
      scrap: { status: 'unavailable', generationId: null, publishedAt: null },
      visits: { status: 'unavailable', asOfDate: null } },
    strategy: { kind: strategyKind, region: strategyKind === 'local' ? `${origin.city}/${origin.state}` : null,
      distanceFromBaseKm: anchor?.distance ?? null },
    days, excluded, counts: { evaluated: candidates.length, suggested: suggested.length,
      inactiveLost: excluded.filter(({ reason }) => reason === 'inactive_lost').length,
      noPurchaseHistory: excluded.filter(({ reason }) => reason === 'no_purchase_history').length,
      needsReview: excluded.filter(({ reason }) => reason === 'client_not_active'
        || reason === 'no_navigable_location' || reason === 'daily_distance_limit'
        || reason === 'daily_capacity_reached' || reason === 'weekly_strategy_mismatch').length,
      coverageDue, coveragePlanned, coveragePending: Math.max(0, coverageDue - coveragePlanned) } });
}
