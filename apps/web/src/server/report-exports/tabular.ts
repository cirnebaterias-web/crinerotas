import type {
  FieldIntelligenceResponse,
  ManagementDayResponse,
  PilotMetricsResponse,
  ScrapAgendaResponse,
} from '@cirne/contracts';
import type { ReportColumn, ReportRow, TabularReport } from '@cirne/domain';

const commonIntelligenceColumns: ReportColumn[] = [
  { key: 'serviceDate', header: 'Data', width: 13 },
  { key: 'seller', header: 'Vendedor', width: 24 },
  { key: 'client', header: 'Cliente', width: 30 },
  { key: 'confirmedAt', header: 'Confirmado em', width: 22 },
];

const activityLabels: Record<string, string> = {
  confirmed: 'Confirmado', not_occurred: 'Não ocorreu', exception: 'Exceção',
  unknown_to_server: 'Ainda não recebido', withheld: 'Acesso restrito',
  action_required: 'Ação necessária',
};

const executionLabels: Record<string, string> = {
  pending: 'Pendente', in_visit: 'Em visita', completed: 'Concluída', not_visited: 'Não visitada',
  in_progress: 'Em andamento',
};

function activityLabelFor(state: string, visitStatus: string) {
  return state === 'not_occurred' && visitStatus === 'in_progress'
    ? 'Ainda não ocorreu'
    : activityLabels[state] ?? state;
}

function commonIntelligenceRow(record: FieldIntelligenceResponse['records'][number]): ReportRow {
  return {
    serviceDate: record.serviceDate,
    seller: record.seller.name,
    client: record.client.name,
    confirmedAt: record.confirmedAt,
  };
}

export function managementDayReport(response: ManagementDayResponse): TabularReport {
  const columns: ReportColumn[] = [
    { key: 'serviceDate', header: 'Data', width: 13 },
    { key: 'seller', header: 'Vendedor', width: 24 },
    { key: 'client', header: 'Cliente', width: 30 },
    { key: 'plannedOrder', header: 'Ordem planejada', width: 18 },
    { key: 'executionOrder', header: 'Ordem de execução', width: 18 },
    { key: 'priority', header: 'Prioridade', width: 12 },
    { key: 'stopStatus', header: 'Situação da parada', width: 20 },
    { key: 'nonVisitReason', header: 'Motivo da não visita', width: 28 },
    { key: 'visitStatus', header: 'Situação da visita', width: 20 },
    { key: 'facade', header: 'Fachada', width: 22 },
    { key: 'checkout', header: 'Checkout', width: 22 },
    { key: 'stock', header: 'Estoque', width: 22 },
    { key: 'prices', header: 'Preços concorrentes', width: 22 },
    { key: 'actions', header: 'Ações comerciais', width: 22 },
    { key: 'scrap', header: 'Sucata', width: 22 },
    { key: 'result', header: 'Resultado', width: 22 },
    { key: 'synchronization', header: 'Sincronização', width: 22 },
    { key: 'exceptions', header: 'Exceções', width: 12 },
    { key: 'lastUpdate', header: 'Última atualização', width: 22 },
  ];
  const rows: ReportRow[] = [];
  for (const route of response.routes) {
    if ('stops' in route) {
      for (const stop of route.stops) {
        const visits = stop.visits.length > 0 ? stop.visits : [null];
        for (const visit of visits) {
          rows.push({
            serviceDate: response.serviceDate, seller: route.seller.displayName, client: stop.client.name,
            plannedOrder: stop.plannedOrder, executionOrder: stop.executionOrder, priority: stop.priority,
            stopStatus: executionLabels[stop.status] ?? stop.status,
            nonVisitReason: stop.nonVisitReason?.label ?? null,
            visitStatus: visit ? executionLabels[visit.status] ?? visit.status : null,
            facade: visit ? activityLabelFor(visit.checklist.facadeCheckin, visit.status) : null,
            checkout: visit ? activityLabelFor(visit.checklist.checkout, visit.status) : null,
            stock: visit ? activityLabelFor(visit.checklist.stock, visit.status) : null,
            prices: visit ? activityLabelFor(visit.checklist.competitorPrices, visit.status) : null,
            actions: visit ? activityLabelFor(visit.checklist.commercialActions, visit.status) : null,
            scrap: visit ? activityLabelFor(visit.checklist.scrap, visit.status) : null,
            result: visit ? activityLabelFor(visit.checklist.result, visit.status) : null,
            synchronization: visit ? activityLabelFor(visit.checklist.synchronization, visit.status) : null,
            exceptions: visit?.exceptionCount ?? 0,
            lastUpdate: visit?.lastKnownUpdateAt ?? stop.lastKnownUpdateAt,
          });
        }
      }
      continue;
    }
    for (const visit of route.visits) {
      rows.push({
        serviceDate: response.serviceDate, seller: route.seller.displayName, client: visit.client.name,
        plannedOrder: null, executionOrder: null, priority: null,
        stopStatus: executionLabels[visit.status] ?? visit.status, nonVisitReason: null,
        visitStatus: executionLabels[visit.status] ?? visit.status,
        facade: null, checkout: null, stock: null, prices: null, actions: null, scrap: null,
        result: null, synchronization: null, exceptions: 0, lastUpdate: visit.lastKnownUpdateAt,
      });
    }
  }
  return { sheetName: 'Central do dia', columns, rows };
}

export function fieldIntelligenceReport(response: FieldIntelligenceResponse): TabularReport {
  if (response.section === 'stock') {
    const columns = [...commonIntelligenceColumns,
      { key: 'heliar', header: 'Qtd. Heliar', width: 14 }, { key: 'moura', header: 'Qtd. Moura', width: 14 },
      { key: 'ownLines', header: 'Linhas próprias', width: 50 },
      { key: 'competitorLines', header: 'Linhas concorrentes', width: 50 }];
    const rows = response.records.map((record) => ({ ...commonIntelligenceRow(record),
      heliar: record.heliarQuantity, moura: record.mouraQuantity,
      ownLines: record.ownLines.map((line) => `${line.brand} ${line.model}: ${line.quantity}`).join(' | '),
      competitorLines: record.competitorLines.map((line) => `${line.otherBrand ?? line.brand} ${line.amperage}Ah ${line.technology}: ${line.quantity}`).join(' | '),
    }));
    return { sheetName: 'Estoque', columns, rows };
  }
  if (response.section === 'prices') {
    const columns = [...commonIntelligenceColumns,
      { key: 'availability', header: 'Disponibilidade', width: 20 },
      { key: 'unavailableReason', header: 'Motivo da indisponibilidade', width: 30 },
      { key: 'competitor', header: 'Concorrente', width: 24 },
      { key: 'model', header: 'Modelo ou amperagem', width: 24 },
      { key: 'technology', header: 'Tecnologia', width: 20 },
      { key: 'price', header: 'Preço (R$)', width: 14 },
      { key: 'condition', header: 'Condição', width: 24 }];
    const rows = response.records.flatMap((record) => {
      const quotations = record.quotations.length > 0 ? record.quotations : [null];
      return quotations.map((quotation) => ({ ...commonIntelligenceRow(record),
        availability: record.availability === 'available' ? 'Disponível' : 'Indisponível',
        unavailableReason: record.unavailableReason?.label ?? null,
        competitor: quotation?.competitor.label ?? null, model: quotation?.modelOrAmperage ?? null,
        technology: quotation?.technology.label ?? null, price: quotation?.priceBrl ?? null,
        condition: quotation?.condition.label ?? null,
      }));
    });
    return { sheetName: 'Preços', columns, rows };
  }
  if (response.section === 'actions') {
    const columns = [...commonIntelligenceColumns,
      { key: 'availability', header: 'Ação identificada', width: 20 },
      { key: 'competitor', header: 'Concorrente', width: 24 },
      { key: 'actionType', header: 'Tipo de ação', width: 24 },
      { key: 'description', header: 'Descrição', width: 50 },
      { key: 'validFrom', header: 'Válida de', width: 13 },
      { key: 'validUntil', header: 'Válida até', width: 13 }];
    const rows = response.records.flatMap((record) => {
      const actions = record.actions.length > 0 ? record.actions : [null];
      return actions.map((action) => ({ ...commonIntelligenceRow(record),
        availability: record.availability === 'identified' ? 'Sim' : 'Não',
        competitor: action?.competitor.label ?? null,
        actionType: action?.otherType ?? action?.actionType ?? null,
        description: action?.description ?? null, validFrom: action?.validFrom ?? null,
        validUntil: action?.validUntil ?? null,
      }));
    });
    return { sheetName: 'Ações', columns, rows };
  }
  if (response.section === 'scrap') {
    const columns = [...commonIntelligenceColumns,
      { key: 'availability', header: 'Situação da sucata', width: 22 },
      { key: 'actualWeight', header: 'Peso real coletado (kg)', width: 24 },
      { key: 'collectedAt', header: 'Coletada em', width: 22 },
      { key: 'estimatedWeight', header: 'Peso estimado agendado (kg)', width: 28 },
      { key: 'desiredDate', header: 'Data desejada', width: 15 },
      { key: 'period', header: 'Período agendado', width: 20 }];
    const rows = response.records.map((record) => ({ ...commonIntelligenceRow(record),
      availability: record.availability === 'collected' ? 'Coletada' : record.availability === 'scheduled' ? 'Agendada' : 'Sem sucata',
      actualWeight: record.collection?.actualWeightKg ?? null,
      collectedAt: record.collection?.collectedAt ?? null,
      estimatedWeight: record.schedule?.estimatedWeightKg ?? null,
      desiredDate: record.schedule?.desiredDate ?? null,
      period: record.schedule?.period === 'morning' ? 'Manhã' : record.schedule?.period === 'afternoon' ? 'Tarde' : null,
    }));
    return { sheetName: 'Sucata', columns, rows };
  }
  const columns = [...commonIntelligenceColumns,
    { key: 'outcome', header: 'Resultado', width: 18 },
    { key: 'deviceStartedAt', header: 'Início no aparelho', width: 22 },
    { key: 'serverStartedAt', header: 'Início no servidor', width: 22 },
    { key: 'deviceCompletedAt', header: 'Conclusão no aparelho', width: 22 },
    { key: 'serverCompletedAt', header: 'Conclusão no servidor', width: 22 }];
  const rows = response.records.map((record) => ({ ...commonIntelligenceRow(record),
    outcome: 'Concluída', deviceStartedAt: record.deviceStartedAt,
    serverStartedAt: record.serverStartedAt, deviceCompletedAt: record.deviceCompletedAt,
    serverCompletedAt: record.serverCompletedAt,
  }));
  return { sheetName: 'Resultados', columns, rows };
}

export function scrapAgendaReport(response: ScrapAgendaResponse): TabularReport {
  const columns: ReportColumn[] = [
    { key: 'desiredDate', header: 'Data desejada', width: 15 },
    { key: 'period', header: 'Período', width: 14 },
    { key: 'seller', header: 'Vendedor', width: 24 },
    { key: 'client', header: 'Cliente', width: 30 },
    { key: 'address', header: 'Endereço', width: 45 },
    { key: 'origin', header: 'Origem', width: 16 },
    { key: 'estimatedWeight', header: 'Peso estimado agendado (kg)', width: 28 },
    { key: 'status', header: 'Situação', width: 16 },
    { key: 'requestedAt', header: 'Solicitado em', width: 22 },
  ];
  const rows = response.records.map((record) => ({
    desiredDate: record.desiredDate, period: record.period === 'morning' ? 'Manhã' : 'Tarde',
    seller: record.seller.displayName, client: record.client.name, address: record.client.address,
    origin: record.origin === 'visit' ? 'Visita' : 'Avulsa', estimatedWeight: record.estimatedWeightKg,
    status: 'Pendente', requestedAt: record.requestedAt,
  }));
  return { sheetName: 'Agenda de sucata', columns, rows };
}

export function pilotMetricsReport(response: PilotMetricsResponse): TabularReport {
  const columns: ReportColumn[] = [
    { key: 'id', header: 'Indicador', width: 12 }, { key: 'name', header: 'Nome', width: 35 },
    { key: 'target', header: 'Meta', width: 16 }, { key: 'assessment', header: 'Avaliação', width: 24 },
    { key: 'numerator', header: 'Numerador', width: 14 }, { key: 'denominator', header: 'Denominador', width: 14 },
    { key: 'percentage', header: 'Percentual observado', width: 22 },
    { key: 'coverage', header: 'Cobertura', width: 28 }, { key: 'formula', header: 'Fórmula', width: 50 },
    { key: 'source', header: 'Fonte', width: 40 }, { key: 'periodicity', header: 'Periodicidade', width: 20 },
    { key: 'requiredSource', header: 'Fonte externa necessária', width: 45 },
    { key: 'note', header: 'Nota', width: 55 },
  ];
  const assessment: Record<string, string> = {
    provisional_met: 'Meta provisoriamente atingida',
    provisional_not_met: 'Meta provisoriamente não atingida', not_evaluable: 'Não avaliável',
  };
  const coverage: Record<string, string> = {
    server_confirmed_cohort: 'Coorte confirmada no servidor', partial_server_view: 'Visão parcial do servidor',
    external_source_required: 'Fonte externa necessária',
  };
  const rows = response.metrics.map((metric) => ({
    id: metric.id, name: metric.name,
    target: `${metric.target.operator === 'gte' ? '≥' : '='} ${metric.target.value}${metric.target.unit === 'percent' ? '%' : ''}`,
    assessment: assessment[metric.assessment] ?? metric.assessment,
    numerator: metric.observation?.numerator ?? null, denominator: metric.observation?.denominator ?? null,
    percentage: metric.observation?.percentage ?? null, coverage: coverage[metric.coverage] ?? metric.coverage,
    formula: metric.formula, source: metric.source, periodicity: metric.periodicity.join(', '),
    requiredSource: metric.requiredSource, note: metric.note,
  }));
  return { sheetName: 'Indicadores do piloto', columns, rows };
}
