import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { clientImportHeaders } from '@cirne/contracts';
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
  });

  it('recusa a planilha inteira quando há mais de 5.000 linhas de clientes', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clientes');
    sheet.addRow([...clientImportHeaders]);
    for (let index = 1; index <= 5001; index += 1) {
      sheet.addRow([`C-${index}`, `Cliente ${index}`, `Rua ${index}`, '', '', '', 'seller@example.com', 'active']);
    }
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    await expect(parseClientWorkbook('clientes.xlsx', bytes)).rejects.toMatchObject({ status: 422 });
  });

  it('interrompe o corpo multipart real quando ele excede o limite anunciado', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'clientes.xlsx'));
    const request = new Request('http://localhost/api/v1/client-imports', { method: 'POST', body: form });
    await expect(readClientImportFile(request)).rejects.toMatchObject({ status: 413 });
  });
});
