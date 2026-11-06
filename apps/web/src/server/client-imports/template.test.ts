import ExcelJS from 'exceljs';
import { expect, it } from 'vitest';
import { createClientImportTemplate } from './template';

it('downloads only the official Base clientes structure without customer data or formulas', async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await createClientImportTemplate()).buffer);
  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Base clientes']);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.getRow(1).values).toEqual([undefined,
    'Razão Social', 'CNPJ/CPF', 'Nome fantasia', 'Carteira', 'Status', 'Cidade', 'Bairro',
    'Latitude', 'Longitude', 'Endereço completo', 'Tipo de cliente', 'Grupo empresarial',
    'Heliar service', 'TIPO', 'CLiente Estratégico', 'Status Geo', 'Endereço encontrado Google',
    'Precisão Google', 'Última consulta Geo', 'Endereço consultado', 'Google Place ID',
  ]);
  expect(sheet.columnCount).toBe(21);
  expect(sheet.actualRowCount).toBe(1);
  sheet.eachRow((row) => row.eachCell((cell) => {
    expect(cell.row).toBe(1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
  }));
  expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1, topLeftCell: 'A2' });
  expect(sheet.getCell('A1').fill).toMatchObject({ fgColor: { argb: 'FF274E13' } });
  expect(sheet.getCell('P1').fill).toMatchObject({ fgColor: { argb: 'FF193B63' } });
  expect(sheet.getCell('B2').numFmt).toBe('@');
  expect(sheet.getCell('B3').numFmt).toBe('@');
  expect(sheet.getCell('B5001').numFmt).toBe('@');
  expect(sheet.getCell('H2').numFmt).toBe('0.0000000');
  expect(sheet.getColumn('J').width).toBe(94.109375);
}, 15_000);
