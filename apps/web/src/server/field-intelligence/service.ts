import {
  fieldIntelligenceFilterSchema,
  fieldIntelligenceResponseSchema,
  type FieldIntelligenceFilter,
  type FieldIntelligenceResponse,
  type MeResponse,
} from '@cirne/contracts';
import { RouteServiceFailure, publicRouteMessage } from '../routes/service';

export type FieldIntelligenceClock = { now(): Date };

export interface FieldIntelligenceRepository {
  get(filters: FieldIntelligenceFilter, operationalTimeZone: string): Promise<FieldIntelligenceResponse>;
}

export function requireFieldIntelligenceAccess(identity: MeResponse) {
  if (!identity.roles.includes('manager') ||
      !identity.capabilities.includes('route.read_scoped') ||
      identity.scopeIds.length === 0) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

function operationalDate(timeZone: string, clock: FieldIntelligenceClock) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(clock.now());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function currentFieldIntelligenceWeek(
  operationalTimeZone: string,
  clock: FieldIntelligenceClock = { now: () => new Date() },
) {
  const today = operationalDate(operationalTimeZone, clock);
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const from = shiftDate(today, -((weekday + 6) % 7));
  return { from, to: shiftDate(from, 6) };
}

export function normalizeFieldIntelligenceFilters(
  input: Record<string, string | undefined>,
  operationalTimeZone: string,
  clock?: FieldIntelligenceClock,
) {
  const hasFrom = input.from !== undefined;
  const hasTo = input.to !== undefined;
  if (hasFrom !== hasTo) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Informe as datas inicial e final juntas.', false);
  }
  const week = currentFieldIntelligenceWeek(operationalTimeZone, clock);
  const parsed = fieldIntelligenceFilterSchema.safeParse({
    section: input.section,
    from: input.from ?? week.from,
    to: input.to ?? week.to,
    sellerId: input.sellerId,
    clientId: input.clientId,
    competitorId: input.competitorId,
    actionType: input.actionType,
    cursor: input.cursor,
  });
  if (!parsed.success) {
    throw new RouteServiceFailure(
      'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Filtros de inteligência inválidos.', false,
    );
  }
  return parsed.data;
}

export async function getFieldIntelligence(
  identity: MeResponse,
  filters: FieldIntelligenceFilter,
  operationalTimeZone: string,
  repository: FieldIntelligenceRepository,
) {
  requireFieldIntelligenceAccess(identity);
  const parsedFilters = fieldIntelligenceFilterSchema.safeParse(filters);
  if (!parsedFilters.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Filtros de inteligência inválidos.', false);
  }
  const parsed = fieldIntelligenceResponseSchema.safeParse(
    await repository.get(parsedFilters.data, operationalTimeZone),
  );
  if (!parsed.success || parsed.data.section !== parsedFilters.data.section) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return parsed.data;
}
