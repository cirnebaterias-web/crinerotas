import ExcelJS from 'exceljs';
import { encodeReportCsv, neutralizeSpreadsheetCell, type TabularReport } from '@cirne/domain';

export function generateCsv(report: TabularReport) {
  return new TextEncoder().encode(encodeReportCsv(report));
}

export async function generateXlsx(report: TabularReport) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cirne Rotas';
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  const worksheet = workbook.addWorksheet(report.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = report.columns.map(({ key, header, width }) => ({ key, header, width: width ?? 18 }));
  for (const row of report.rows) {
    worksheet.addRow(Object.fromEntries(report.columns.map(({ key }) => [key, neutralizeSpreadsheetCell(row[key] ?? null)])));
  }
  if (report.columns.length > 0) {
    worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: report.columns.length } };
  }
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173B57' } };
  header.alignment = { vertical: 'middle' };
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
