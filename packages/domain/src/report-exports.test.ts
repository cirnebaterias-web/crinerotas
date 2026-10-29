import { describe, expect, it } from 'vitest';
import { encodeReportCsv, neutralizeSpreadsheetCell, reportExportFileName } from './report-exports';

describe('report exports', () => {
  it('neutralizes spreadsheet formulas without changing numbers', () => {
    expect(neutralizeSpreadsheetCell('=HYPERLINK("https://invalid")')).toBe('\'=HYPERLINK("https://invalid")');
    expect(neutralizeSpreadsheetCell('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(neutralizeSpreadsheetCell(12.5)).toBe(12.5);
  });

  it('encodes UTF-8 CSV with BOM, semicolon, CRLF and deterministic escaping', () => {
    const csv = encodeReportCsv({
      sheetName: 'Teste',
      columns: [{ key: 'client', header: 'Cliente' }, { key: 'note', header: 'Observação' }],
      rows: [{ client: 'Loja; Centro', note: 'Linha 1\n"Linha 2"' }],
    });
    expect(csv).toBe('\uFEFFCliente;Observação\r\n"Loja; Centro";"Linha 1\n""Linha 2"""\r\n');
  });

  it('builds a server-controlled deterministic filename', () => {
    expect(reportExportFileName({
      view: 'field_intelligence', format: 'xlsx', from: '2026-10-01', to: '2026-10-29',
    })).toBe('cirne-inteligencia-de-campo-2026-10-01-a-2026-10-29.xlsx');
  });
});
