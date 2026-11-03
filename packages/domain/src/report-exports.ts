import type { ReportExportFormat, ReportExportView } from '@cirne/contracts';

export type ReportCell = string | number | boolean | null;
export type ReportColumn = { key: string; header: string; width?: number };
export type ReportRow = Record<string, ReportCell>;
export type TabularReport = {
  sheetName: string;
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
};

const formulaPrefix = /^[=+\-@]/u;

export function neutralizeSpreadsheetCell(value: ReportCell): ReportCell {
  if (typeof value !== 'string') return value;
  const normalized = value.replace(/\r\n|\r/gu, '\n');
  return formulaPrefix.test(normalized) ? `'${normalized}` : normalized;
}

function csvCell(value: ReportCell) {
  const normalized = neutralizeSpreadsheetCell(value);
  const text = normalized === null ? '' : typeof normalized === 'boolean'
    ? normalized ? 'Sim' : 'Não'
    : String(normalized);
  return /[;"\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function encodeReportCsv(report: TabularReport) {
  const lines = [
    report.columns.map(({ header }) => csvCell(header)).join(';'),
    ...report.rows.map((row) => report.columns.map(({ key }) => csvCell(row[key] ?? null)).join(';')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const fileSlugs: Record<ReportExportView, string> = {
  management_day: 'central-do-dia',
  field_intelligence: 'inteligencia-de-campo',
  scrap_agenda: 'agenda-de-sucata',
  pilot_metrics: 'indicadores-do-piloto',
};

export function reportExportFileName(input: {
  view: ReportExportView;
  format: ReportExportFormat;
  from: string;
  to?: string;
}) {
  const period = input.to && input.to !== input.from ? `${input.from}-a-${input.to}` : input.from;
  return `cirne-${fileSlugs[input.view]}-${period}.${input.format}`;
}
