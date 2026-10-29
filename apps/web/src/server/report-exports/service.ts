import {
  reportExportMetadataSchema,
  type FieldIntelligenceFilter,
  type MeResponse,
  type ReportExportQuery,
  type ScrapAgendaFilter,
} from '@cirne/contracts';
import { reportExportFileName, type TabularReport } from '@cirne/domain';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getFieldIntelligence } from '../field-intelligence/service';
import { SupabaseFieldIntelligenceRepository } from '../field-intelligence/supabase-repository';
import { getManagementDay } from '../management-day/service';
import { SupabaseManagementDayRepository } from '../management-day/supabase-repository';
import { getPilotMetrics } from '../pilot-metrics/service';
import { SupabasePilotMetricsRepository } from '../pilot-metrics/supabase-repository';
import { RouteServiceFailure } from '../routes/service';
import { getScrapAgenda } from '../scrap-agenda/service';
import { SupabaseScrapAgendaRepository } from '../scrap-agenda/supabase-repository';
import { generateCsv, generateXlsx } from './generate';
import {
  fieldIntelligenceReport,
  managementDayReport,
  pilotMetricsReport,
  scrapAgendaReport,
} from './tabular';

const maxRows = 10_000;
const maxPages = 1_000;

function appendReport(target: TabularReport | null, page: TabularReport) {
  if (!target) {
    if (page.rows.length > maxRows) {
      throw new RouteServiceFailure('VALIDATION_FAILED', 'O recorte excede o limite de 10.000 linhas. Reduza os filtros.', false);
    }
    return { ...page, rows: [...page.rows] };
  }
  const sameColumns = target.columns.length === page.columns.length &&
    target.columns.every((column, index) => column.key === page.columns[index]?.key);
  if (!sameColumns || target.sheetName !== page.sheetName) {
    throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', 'A projeção do relatório mudou durante a exportação.', true);
  }
  const rows = [...target.rows, ...page.rows];
  if (rows.length > maxRows) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'O recorte excede o limite de 10.000 linhas. Reduza os filtros.', false);
  }
  return { ...target, rows };
}

export async function collectPaginatedReport<TPage extends { nextCursor: string | null }>(
  loadPage: (cursor: string | undefined) => Promise<TPage>,
  mapPage: (page: TPage) => TabularReport,
) {
  let report: TabularReport | null = null;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await loadPage(cursor);
    report = appendReport(report, mapPage(page));
    if (!page.nextCursor) return report;
    if (seen.has(page.nextCursor)) {
      throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', 'A paginação do relatório não avançou.', true);
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new RouteServiceFailure('DEPENDENCY_UNAVAILABLE', 'A paginação do relatório excedeu o limite operacional.', true);
}

async function completeFieldIntelligence(
  identity: MeResponse,
  query: Extract<ReportExportQuery, { view: 'field_intelligence' }>,
  operationalTimeZone: string,
  repository: SupabaseFieldIntelligenceRepository,
) {
  return collectPaginatedReport(async (cursor) => {
    const filters: FieldIntelligenceFilter = {
      section: query.section, from: query.from, to: query.to,
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.competitorId ? { competitorId: query.competitorId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return getFieldIntelligence(identity, filters, operationalTimeZone, repository);
  }, fieldIntelligenceReport);
}

async function completeScrapAgenda(
  identity: MeResponse,
  query: Extract<ReportExportQuery, { view: 'scrap_agenda' }>,
  repository: SupabaseScrapAgendaRepository,
) {
  return collectPaginatedReport(async (cursor) => {
    const filters: ScrapAgendaFilter = {
      from: query.from, to: query.to, status: query.status,
      ...(query.period ? { period: query.period } : {}),
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(cursor ? { cursor } : {}),
    };
    return getScrapAgenda(identity, filters, repository);
  }, scrapAgendaReport);
}

export async function createReportExport(input: {
  identity: MeResponse;
  query: ReportExportQuery;
  operationalTimeZone: string;
  client: SupabaseClient;
}) {
  const { identity, query, operationalTimeZone, client } = input;
  let report: TabularReport;
  let from: string;
  let to: string | undefined;
  if (query.view === 'management_day') {
    report = managementDayReport(await getManagementDay(
      identity, query.serviceDate, operationalTimeZone, new SupabaseManagementDayRepository(client),
    ));
    from = query.serviceDate;
  } else if (query.view === 'field_intelligence') {
    report = await completeFieldIntelligence(
      identity, query, operationalTimeZone, new SupabaseFieldIntelligenceRepository(client),
    );
    from = query.from;
    to = query.to;
  } else if (query.view === 'scrap_agenda') {
    report = await completeScrapAgenda(identity, query, new SupabaseScrapAgendaRepository(client));
    from = query.from;
    to = query.to;
  } else {
    const filters = {
      from: query.from, to: query.to,
      ...(query.sellerId ? { sellerId: query.sellerId } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
    };
    report = pilotMetricsReport(await getPilotMetrics(
      identity, filters, operationalTimeZone, new SupabasePilotMetricsRepository(client),
    ));
    from = query.from;
    to = query.to;
  }
  if (report.rows.length > maxRows) {
    throw new RouteServiceFailure('VALIDATION_FAILED', 'O recorte excede o limite de 10.000 linhas. Reduza os filtros.', false);
  }
  const contentType = query.format === 'csv'
    ? 'text/csv; charset=utf-8' as const
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
  const metadata = reportExportMetadataSchema.parse({
    schemaVersion: 1, view: query.view, format: query.format,
    fileName: reportExportFileName({ view: query.view, format: query.format, from, ...(to ? { to } : {}) }),
    contentType, rowCount: report.rows.length,
  });
  const bytes = query.format === 'csv' ? generateCsv(report) : await generateXlsx(report);
  return { metadata, bytes };
}
