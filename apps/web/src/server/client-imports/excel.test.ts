import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { clientImportHeaders, clientSheetHeaders } from '@cirne/contracts';
import { parseClientWorkbook, readClientImportFile } from './excel';

async function workbookBytes(rows: unknown[][], headers: readonly string[] = clientImportHeaders) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Clientes');
  sheet.addRow([...headers]);
  for (const row of rows) sheet.addRow(row);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

describe('parseClientWorkbook', () => {
  it('aceita coordenadas negativas e normaliza a linha canônica', async () => {
    const result = await parseClientWorkbook('clientes.xlsx', await workbookBytes([
      ['C-001', 'Cliente Sintético', 'Rua Teste, 1', -5.79, -35.21, 'NATAL', 'SELLER@EXAMPLE.COM', ''],
    ]));
    expect(result.issues).toEqual([]);
    expect(result).toMatchObject({ totalCount: 1, acceptedCount: 1, rejectedCount: 0 });
    expect(result.rows[0]).toMatchObject({ externalReference: 'C-001', latitude: -5.79,
      longitude: -35.21, sellerEmail: 'seller@example.com', status: 'active' });
  });

  it('rejeita fórmulas e referências duplicadas sem executar a célula', async () => {
    const bytes = await workbookBytes([
      ['C-001', { formula: 'HYPERLINK("https://invalid.example")', result: 'Clique' }, 'Rua 1', -5, -35, '', 'seller@example.com', 'active'],
      ['C-001', 'Outro', 'Rua 2', -6, -36, '', 'seller@example.com', 'active'],
    ]);
    const result = await parseClientWorkbook('clientes.xlsx', bytes);
    expect(result.acceptedCount).toBe(0);
    expect(result.rejectedCount).toBe(2);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['FORMULA_NOT_ALLOWED', 'DUPLICATE_REFERENCE']));
  });

  it('falha fechada quando os cabeçalhos não correspondem ao modelo', async () => {
    const headers: string[] = [...clientImportHeaders]; headers[0] = 'codigo';
    const result = await parseClientWorkbook('clientes.xlsx', await workbookBytes([], headers));
    expect(result.rows).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ rowNumber: 1, code: 'INVALID_HEADER' }));
  });

  it('normaliza o modelo oficial de 21 colunas com mapeamento explícito de carteira', async () => {
    const row = ['Cliente Sintético Ltda.', '01.234.567/0001-99', 'Cliente Sintético',
      ' Carteira Teste ', ' ATIVO ', 'Natal', 'Centro', -5.79, -35.21, 'Rua Teste, 1'];
    const result = await parseClientWorkbook('Base clientes.xlsx',
      await workbookBytes([row], clientSheetHeaders),
      { 'CARTEIRA TESTE': 'seller@example.invalid' });
    expect(result).toMatchObject({ totalCount: 1, acceptedCount: 1, rejectedCount: 0,
      sourceName: 'Base clientes.xlsx' });
    expect(result.rows[0]).toMatchObject({ externalReference: '01234567000199',
      name: 'Cliente Sintético Ltda.', address: 'Rua Teste, 1',
      portfolioReference: 'Carteira Teste', sellerEmail: 'seller@example.invalid', status: 'active' });
  });

  it('mantém carteira sem mapeamento pendente e ignora OUTROS no modelo oficial', async () => {
    const pending = ['Cliente Pendente', '01.234.567/0001-99', '', 'SEM MAPA', 'ATIVO', '', '', '', '', 'Rua 1'];
    const ignored = ['Cliente Ignorado', '98.765.432/0001-10', '', 'OUTROS', '', '', '', '', '', 'Rua 2'];
    const result = await parseClientWorkbook('Base clientes.xlsx',
      await workbookBytes([pending, ignored], clientSheetHeaders));
    expect(result).toMatchObject({ totalCount: 1, acceptedCount: 0, rejectedCount: 1,
      issues: [expect.objectContaining({ rowNumber: 2, code: 'PORTFOLIO_PENDING_REVIEW' })] });
  });

  it('rejeita fórmulas nos campos usados do modelo oficial', async () => {
    const row = ['Cliente Sintético', '01.234.567/0001-99', '', 'TESTE', 'ATIVO', '', '',
      { formula: '1+1', result: -5 }, { formula: '1+1', result: -35 }, 'Rua Teste, 1'];
    const result = await parseClientWorkbook('Base clientes.xlsx',
      await workbookBytes([row], clientSheetHeaders), { TESTE: 'seller@example.invalid' });
    expect(result).toMatchObject({ acceptedCount: 0, rejectedCount: 1,
      issues: [expect.objectContaining({ rowNumber: 2, code: 'FORMULA_NOT_ALLOWED' })] });
  });

  it('ignora formatação vazia distante e recusa dados oficiais além da linha limite', async () => {
    const formatted = new ExcelJS.Workbook();
    const formattedSheet = formatted.addWorksheet('Base clientes');
    formattedSheet.addRow([...clientSheetHeaders]);
    formattedSheet.getRow(6000).getCell(1).font = { bold: true };
    const formattedResult = await parseClientWorkbook('Base clientes.xlsx',
      new Uint8Array(await formatted.xlsx.writeBuffer()));
    expect(formattedResult).toMatchObject({ totalCount: 0, acceptedCount: 0, rejectedCount: 0 });

    const excessive = new ExcelJS.Workbook();
    const excessiveSheet = excessive.addWorksheet('Base clientes');
    excessiveSheet.addRow([...clientSheetHeaders]);
    excessiveSheet.getRow(5002).values = ['Cliente Sintético', '01.234.567/0001-99', '',
      'TESTE', 'ATIVO', '', '', '', '', 'Rua Teste, 1'];
    await expect(parseClientWorkbook('Base clientes.xlsx',
      new Uint8Array(await excessive.xlsx.writeBuffer()), { TESTE: 'seller@example.invalid' }))
      .rejects.toMatchObject({ status: 422 });
  });

  it('processa linhas válidas depois de intervalos vazios', async () => {
    const result = await parseClientWorkbook('clientes.xlsx', await workbookBytes([
      ['C-001', 'Primeiro Cliente', 'Rua 1', -5, -35, '', 'seller@example.com', 'active'],
      [],
      ['C-002', 'Segundo Cliente', 'Rua 2', -6, -36, '', 'seller@example.com', 'active'],
    ]));
    expect(result).toMatchObject({ totalCount: 2, acceptedCount: 2, rejectedCount: 0 });
    expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
  });

  it('rejeita uma linha que contenha somente fórmula', async () => {
    const result = await parseClientWorkbook('clientes.xlsx', await workbookBytes([
      [{ formula: '1+1', result: 2 }],
    ]));
    expect(result).toMatchObject({ totalCount: 1, acceptedCount: 0, rejectedCount: 1 });
    expect(result.issues).toContainEqual(expect.objectContaining({ rowNumber: 2, code: 'FORMULA_NOT_ALLOWED' }));
  });

  it('interrompe uma planilha compactada cujo conteúdo expandido exceda o limite', async () => {
    const archive = new JSZip();
    archive.file('xl/sharedStrings.xml', 'x'.repeat(17 * 1024 * 1024));
    const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    await expect(parseClientWorkbook('clientes.xlsx', bytes)).rejects.toMatchObject({ status: 413 });
  }, 10000);

  it('recusa a planilha inteira quando há mais de 5.000 linhas de clientes', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clientes');
    sheet.addRow([...clientImportHeaders]);
    for (let index = 1; index <= 5001; index += 1) {
      sheet.addRow([`C-${index}`, `Cliente ${index}`, `Rua ${index}`, '', '', '', 'seller@example.com', 'active']);
    }
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    await expect(parseClientWorkbook('clientes.xlsx', bytes)).rejects.toMatchObject({ status: 422 });
  }, 15000);

  it('interrompe o corpo multipart real quando ele excede o limite anunciado', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'clientes.xlsx'));
    const request = new Request('http://localhost/api/v1/client-imports', { method: 'POST', body: form });
    await expect(readClientImportFile(request)).rejects.toMatchObject({ status: 413 });
  });
});
