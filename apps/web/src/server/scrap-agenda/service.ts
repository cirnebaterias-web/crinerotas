import {
  scrapAgendaFilterSchema,
  scrapAgendaResponseSchema,
  type MeResponse,
  type ScrapAgendaFilter,
  type ScrapAgendaResponse,
} from '@cirne/contracts';
import { currentFieldIntelligenceWeek, type FieldIntelligenceClock } from '../field-intelligence/service';
import { publicRouteMessage, RouteServiceFailure } from '../routes/service';

export type ScrapAgendaClock = FieldIntelligenceClock;

export interface ScrapAgendaRepository {
  get(filters: ScrapAgendaFilter): Promise<ScrapAgendaResponse>;
}

export function requireScrapAgendaAccess(identity: MeResponse) {
  const canRead = identity.status === 'active' && identity.capabilities.includes('scrap.read_operations');
  const operationalRole = identity.roles.includes('administrator') || identity.roles.includes('logistics');
  const scopedManager = identity.roles.includes('manager') && identity.scopeIds.length > 0;
  if (!canRead || (!operationalRole && !scopedManager)) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export function normalizeScrapAgendaFilters(
  input: Record<string, string | undefined>,
  operationalTimeZone: string,
  clock?: ScrapAgendaClock,
) {
  const hasFrom = input.from !== undefined;
  const hasTo = input.to !== undefined;
  if (hasFrom !== hasTo) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Informe as datas inicial e final juntas.', false);
  }
  const week = currentFieldIntelligenceWeek(operationalTimeZone, clock);
  const parsed = scrapAgendaFilterSchema.safeParse({
    from: input.from ?? week.from,
    to: input.to ?? week.to,
    status: input.status ?? 'pending',
    period: input.period,
    sellerId: input.sellerId,
    clientId: input.clientId,
    cursor: input.cursor,
  });
  if (!parsed.success) {
    throw new RouteServiceFailure(
      'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Filtros da agenda de sucata inválidos.', false,
    );
  }
  return parsed.data;
}

export async function getScrapAgenda(
  identity: MeResponse,
  filters: ScrapAgendaFilter,
  repository: ScrapAgendaRepository,
) {
  requireScrapAgendaAccess(identity);
  const parsedFilters = scrapAgendaFilterSchema.safeParse(filters);
  if (!parsedFilters.success) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Filtros da agenda de sucata inválidos.', false);
  }
  const operationalRole = identity.roles.includes('administrator') || identity.roles.includes('logistics');
  if (!operationalRole && identity.roles.includes('manager') &&
      parsedFilters.data.sellerId &&
      !identity.scopeIds.includes(parsedFilters.data.sellerId)) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
  const parsed = scrapAgendaResponseSchema.safeParse(await repository.get(parsedFilters.data));
  if (!parsed.success) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
  return parsed.data;
}
