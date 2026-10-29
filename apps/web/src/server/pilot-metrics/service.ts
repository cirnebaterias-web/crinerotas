import {
  pilotMetricsFilterSchema,
  pilotMetricsResponseSchema,
  type MeResponse,
  type PilotMetric,
  type PilotMetricsFilter,
  type PilotMetricsResponse,
} from '@cirne/contracts';
import { RouteServiceFailure, publicRouteMessage } from '../routes/service';
import { currentFieldIntelligenceWeek, type FieldIntelligenceClock } from '../field-intelligence/service';

export interface PilotMetricsProjection {
  generatedAt: string;
  lastServerConfirmedAt: string | null;
  totals: {
    completed: number;
    requiredComplete: number;
    scrapReported: number;
    commercialActionReported: number;
    syncWithin24h: number;
    syncEligible: number;
    windowOpen: number;
    clockSuspicious: number;
  };
  records: PilotMetricsResponse['records'];
  nextCursor: string | null;
}

export interface PilotMetricsRepository {
  get(filters: PilotMetricsFilter, operationalTimeZone: string): Promise<PilotMetricsProjection>;
}

export function requirePilotMetricsAccess(identity: MeResponse) {
  if (!identity.roles.includes('manager') ||
      !identity.capabilities.includes('route.read_scoped') ||
      identity.scopeIds.length === 0) {
    throw new RouteServiceFailure('FORBIDDEN', publicRouteMessage('FORBIDDEN'), false);
  }
}

export function normalizePilotMetricsFilters(
  input: Record<string, string | undefined>,
  operationalTimeZone: string,
  clock?: FieldIntelligenceClock,
) {
  if ((input.from !== undefined) !== (input.to !== undefined)) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'Informe as datas inicial e final juntas.', false);
  }
  const week = currentFieldIntelligenceWeek(operationalTimeZone, clock);
  const parsed = pilotMetricsFilterSchema.safeParse({
    from: input.from ?? week.from,
    to: input.to ?? week.to,
    sellerId: input.sellerId,
    clientId: input.clientId,
    cursor: input.cursor,
  });
  if (!parsed.success) {
    throw new RouteServiceFailure(
      'VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Filtros das métricas do piloto inválidos.', false,
    );
  }
  return parsed.data;
}

function percentage(numerator: number, denominator: number) {
  if (denominator === 0) return null;
  return ((numerator * 100) / denominator).toFixed(2).replace(/\.00$/u, '').replace(/(\.\d)0$/u, '$1');
}

function observedMetric(input: {
  id: PilotMetric['id']; name: string; target: string; formula: string; source: string;
  periodicity: PilotMetric['periodicity']; coverage: PilotMetric['coverage'];
  numerator: number; denominator: number; targetValue: number;
  exclusions?: { windowOpen: number; clockSuspicious: number };
}): PilotMetric {
  const observed = percentage(input.numerator, input.denominator);
  return {
    id: input.id,
    name: input.name,
    target: { operator: 'gte', value: input.target, unit: 'percent' },
    formula: input.formula,
    source: input.source,
    periodicity: input.periodicity,
    coverage: input.coverage,
    assessment: observed === null
      ? 'not_evaluable'
      : input.numerator * 100 >= input.targetValue * input.denominator
        ? 'provisional_met'
        : 'provisional_not_met',
    observation: {
      numerator: input.numerator,
      denominator: input.denominator,
      percentage: observed,
      exclusions: input.exclusions ?? { windowOpen: 0, clockSuspicious: 0 },
    },
    requiredSource: null,
    note: input.coverage === 'partial_server_view'
      ? 'Resultado provisório da coorte recebida pelo servidor; conclusões ainda somente no aparelho são desconhecidas.'
      : 'Resultado provisório restrito às visitas concluídas e confirmadas pelo servidor.',
  };
}

const externalMetrics: PilotMetric[] = [
  {
    id: 'SM-01', name: 'Visitas executadas registradas integralmente',
    target: { operator: 'gte', value: '90', unit: 'percent' },
    formula: 'Visitas físicas reconhecidas com registro completo no app ÷ total de visitas físicas reconhecidas × 100',
    source: 'Visitas + reconciliação do Gestor', periodicity: ['weekly', 'final'],
    coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
    requiredSource: 'Método externo de reconciliação de visitas físicas previsto em AB-17.',
    note: 'Sem reconciliação aprovada, ausência de registro não pode ser classificada como zero ou sucesso.',
  },
  {
    id: 'SM-06', name: 'Participantes sem ajuda diária após a primeira semana',
    target: { operator: 'gte', value: '100', unit: 'percent' },
    formula: 'Participantes ativos sem intervenção diária nas semanas 2–4 ÷ participantes ativos nas semanas 2–4 × 100',
    source: 'Registro de suporte + participantes', periodicity: ['weekly'],
    coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
    requiredSource: 'Registro classificado de suporte e participantes ativos nas semanas 2–4.',
    note: 'Ajuda pontual, treinamento e intervenção necessária ainda não possuem fonte canônica.',
  },
  {
    id: 'SM-07', name: 'Perda de registro confirmado',
    target: { operator: 'eq', value: '0', unit: 'count' },
    formula: 'Contagem de registros confirmados que se tornaram irrecuperáveis',
    source: 'Visitas + sincronização + auditoria + teste de recuperação', periodicity: ['continuous', 'final'],
    coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
    requiredSource: 'Reconciliação de perdas e evidência periódica de teste de recuperação.',
    note: 'A inexistência de fonte de reconciliação não comprova perda zero.',
  },
  {
    id: 'SM-08', name: 'Incidente crítico de exposição de dados',
    target: { operator: 'eq', value: '0', unit: 'count' },
    formula: 'Contagem de incidentes classificados como críticos pela política aprovada',
    source: 'Logs de segurança + registro de incidentes', periodicity: ['continuous', 'final'],
    coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
    requiredSource: 'Política de severidade aprovada e registro operacional de incidentes.',
    note: 'Ausência de registro canônico de incidentes não comprova incidente zero.',
  },
  {
    id: 'SM-09', name: 'Disponibilidade na janela do piloto',
    target: { operator: 'gte', value: '99', unit: 'percent' },
    formula: 'Minutos disponíveis ÷ minutos totais da janela operacional acordada × 100',
    source: 'Health checks e monitoramento externo', periodicity: ['daily', 'weekly', 'final'],
    coverage: 'external_source_required', assessment: 'not_evaluable', observation: null,
    requiredSource: 'Janela operacional, manutenção planejada e monitor externo aprovados.',
    note: 'A aplicação não substitui a fonte independente de disponibilidade.',
  },
];

export function assemblePilotMetrics(filters: PilotMetricsFilter, projection: PilotMetricsProjection) {
  const total = projection.totals.completed;
  const metrics: PilotMetric[] = [
    externalMetrics[0]!,
    observedMetric({
      id: 'SM-02', name: 'Visitas encerradas com campos obrigatórios completos', target: '95', targetValue: 95,
      formula: 'Visitas concluídas que passam validação integral ÷ visitas concluídas confirmadas pelo servidor × 100',
      source: 'Visita + etapas obrigatórias + validações', periodicity: ['daily', 'weekly', 'final'],
      coverage: 'server_confirmed_cohort', numerator: projection.totals.requiredComplete, denominator: total,
    }),
    observedMetric({
      id: 'SM-03', name: 'Visitas com informe de sucata', target: '100', targetValue: 100,
      formula: 'Visitas concluídas com resposta válida de sucata ÷ visitas concluídas confirmadas pelo servidor × 100',
      source: 'Relatório de sucata + visita', periodicity: ['daily', 'weekly', 'final'],
      coverage: 'server_confirmed_cohort', numerator: projection.totals.scrapReported, denominator: total,
    }),
    observedMetric({
      id: 'SM-04', name: 'Visitas com informe de ação concorrente', target: '100', targetValue: 100,
      formula: 'Visitas concluídas com ação detalhada ou resposta negativa explícita ÷ visitas concluídas confirmadas pelo servidor × 100',
      source: 'Relatório de ação concorrente + visita', periodicity: ['daily', 'weekly', 'final'],
      coverage: 'server_confirmed_cohort', numerator: projection.totals.commercialActionReported, denominator: total,
    }),
    observedMetric({
      id: 'SM-05', name: 'Registros sincronizados em até 24 horas', target: '98', targetValue: 98,
      formula: 'Visitas recebidas até 24 h após conclusão local ÷ coorte recebida pelo servidor com janela encerrada × 100',
      source: 'Visita + horários de conclusão local e no servidor', periodicity: ['daily', 'weekly', 'final'],
      coverage: 'partial_server_view', numerator: projection.totals.syncWithin24h,
      denominator: projection.totals.syncEligible,
      exclusions: { windowOpen: projection.totals.windowOpen, clockSuspicious: projection.totals.clockSuspicious },
    }),
    ...externalMetrics.slice(1),
  ];
  const normalizedFilters = {
    from: filters.from, to: filters.to,
    ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
  };
  return pilotMetricsResponseSchema.parse({
    schemaVersion: 1,
    filters: normalizedFilters,
    generatedAt: projection.generatedAt,
    lastServerConfirmedAt: projection.lastServerConfirmedAt,
    metrics,
    records: projection.records,
    nextCursor: projection.nextCursor,
    serverVisibilityNote: 'Somente fatos confirmados pelo servidor são observados; fontes externas e conteúdo ainda apenas no aparelho permanecem não avaliáveis.',
  });
}

export async function getPilotMetrics(
  identity: MeResponse,
  filters: PilotMetricsFilter,
  operationalTimeZone: string,
  repository: PilotMetricsRepository,
) {
  requirePilotMetricsAccess(identity);
  const parsed = pilotMetricsFilterSchema.safeParse(filters);
  if (!parsed.success) throw new RouteServiceFailure('VALIDATION_FAILED', 'Filtros das métricas do piloto inválidos.', false);
  try {
    return assemblePilotMetrics(parsed.data, await repository.get(parsed.data, operationalTimeZone));
  } catch (error) {
    if (error instanceof RouteServiceFailure) throw error;
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', publicRouteMessage('DEPENDENCY_UNAVAILABLE'), true);
  }
}
