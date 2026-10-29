import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { generateCsv, generateXlsx } from './generate';

const report = {
  sheetName: 'Teste seguro',
  columns: [{ key: 'name', header: 'Nome', width: 24 }, { key: 'value', header: 'Valor', width: 16 }],
  rows: [{ name: '=HYPERLINK("https://invalid.example")', value: '10.50' }],
};

describe('report file generation', () => {
  it('generates interoperable CSV and neutralizes formula prefixes', () => {
    const bytes = generateCsv(report);
    const value = new TextDecoder().decode(bytes);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(value).toContain('\r\n');
    expect(value).toContain("'=HYPERLINK");
  });

  it('generates a frozen, filtered XLSX without formula cells', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await generateXlsx(report)) as never);
    const sheet = workbook.getWorksheet('Teste seguro')!;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toBeTruthy();
    expect(sheet.getCell('A2').value).toBe("'=HYPERLINK(\"https://invalid.example\")");
    expect(sheet.getCell('A2').type).not.toBe(ExcelJS.ValueType.Formula);
  });
});
