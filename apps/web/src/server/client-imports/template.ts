import ExcelJS from 'exceljs';

// Structure and styles of Docs/Base clientes.xlsx, worksheet "Base clientes".
// Keep this metadata independent of the source workbook's customer records.
const columns = [
  ['Razão Social', 53.88671875], ['CNPJ/CPF', 16.21875], ['Nome fantasia', 46],
  ['Carteira', 26.6640625], ['Status', 16.21875], ['Cidade', 25.77734375],
  ['Bairro', 29.109375], ['Latitude', 10.33203125], ['Longitude', 11.21875],
  ['Endereço completo', 94.109375], ['Tipo de cliente', 12.6640625],
  ['Grupo empresarial', 42], ['Heliar service', 11.88671875], ['TIPO', 20],
  ['CLiente Estratégico', undefined], ['Status Geo', 29.33203125],
  ['Endereço encontrado Google', 86.21875], ['Precisão Google', undefined],
  ['Última consulta Geo', 14], ['Endereço consultado', 81.21875],
  ['Google Place ID', undefined],
] as const;

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb }, bgColor: { argb } };
}

export async function createClientImportTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Base clientes', {
    properties: { defaultRowHeight: 15.75, defaultColWidth: 12.6640625, dyDescent: 0,
      outlineProperties: { summaryBelow: false, summaryRight: false } },
    views: [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2',
      showGridLines: true, zoomScale: 100, zoomScaleNormal: 100 }],
    pageSetup: { fitToPage: false, margins: { left: 0.511811024, right: 0.511811024,
      top: 0.787401575, bottom: 0.787401575, header: 0.31496062, footer: 0.31496062 } },
  });
  sheet.getRow(2).height = 15.75;
  columns.forEach(([header, width], index) => {
    const position = index + 1;
    if (width !== undefined) sheet.getColumn(position).width = width;
    const heading = sheet.getCell(1, position);
    heading.value = header;
    heading.font = { name: 'Calibri', size: 9, color: { argb: 'FFFFFFFF' },
      ...(position !== 15 ? { bold: true } : {}) };
    heading.fill = fill(position <= 15 ? 'FF274E13' : 'FF193B63');
    if (position <= 14) heading.alignment = { horizontal: 'center', vertical: 'middle' };

    const input = sheet.getCell(2, position);
    input.font = { name: 'Calibri', size: position <= 14 ? 11 : 10, color: { theme: 1 } };
    input.fill = fill('FFD9EAD3');
    if (position <= 2) input.numFmt = '@';
    if (position === 2) input.alignment = { horizontal: 'center' };
    if (position === 8 || position === 9) input.numFmt = '0.0000000';
    if (position === 19) input.numFmt = 'm/d/yy "h":mm';
  });
  // Preserve leading zeros throughout the supported 5,000-customer input range.
  for (let row = 3; row <= 5001; row += 1) {
    sheet.getCell(row, 1).numFmt = '@';
    sheet.getCell(row, 2).numFmt = '@';
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
