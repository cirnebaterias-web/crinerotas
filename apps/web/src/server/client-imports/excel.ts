import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  clientImportHeaders,
  clientImportPreviewSchema,
  clientImportRowSchema,
  type ClientImportIssue,
  type ClientImportPreview,
  type ClientImportRow,
} from '@cirne/contracts';
import { RouteRequestError } from '../routes/http';

const maxFileBytes = 5 * 1024 * 1024;
const maxRows = 5000;
const maxArchiveEntries = 1000;
const maxExpandedEntryBytes = 16 * 1024 * 1024;
const maxExpandedWorkbookBytes = 40 * 1024 * 1024;
const maxRequestBytes = maxFileBytes + 64 * 1024;
const textualColumns = new Set([0, 1, 2, 5, 6, 7]);

type ZipByteStream = {
  on(event: 'data', callback: (chunk: Uint8Array) => void): ZipByteStream;
  on(event: 'end', callback: () => void): ZipByteStream;
  on(event: 'error', callback: (error: Error) => void): ZipByteStream;
  pause(): ZipByteStream;
  resume(): ZipByteStream;
};

function cellValue(cell: ExcelJS.Cell) {
  if (cell.type === ExcelJS.ValueType.Formula ||
    (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value))) {
    return { formula: true, value: '' };
  }
  const value = cell.value;
  if (value === null || value === undefined) return { formula: false, value: '' };
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return { formula: false, value: value.text.trim() };
    return { formula: false, value: cell.text.trim() };
  }
  return { formula: false, value: typeof value === 'string' ? value.trim() : value };
}
function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function coordinate(value: unknown, min: number, max: number) {
  if (value === '') return { value: null as number | null };
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? { value: parsed }
    : { value: null as number | null, error: true };
}

function issue(rowNumber: number, code: string, message: string): ClientImportIssue {
  return { rowNumber, code, message };
}

function assertBoundedZipMetadata(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'A planilha Excel não pôde ser lida.', false);
  }
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const diskEntries = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  const zip64 = diskEntries === 0xffff || totalEntries === 0xffff ||
    centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (zip64 || diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries ||
      endOffset + 22 + commentLength > bytes.byteLength || centralOffset + centralSize > endOffset) {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'A planilha Excel não pôde ser lida.', false);
  }
  if (totalEntries > maxArchiveEntries) {
    throw new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha possui conteúdo interno excessivo.', false);
  }
}

async function assertBoundedWorkbookArchive(bytes: Uint8Array) {
  assertBoundedZipMetadata(bytes);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(bytes, { createFolders: false });
  } catch {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'A planilha Excel não pôde ser lida.', false);
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > maxArchiveEntries) {
    throw new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha possui conteúdo interno excessivo.', false);
  }
  let expandedWorkbookBytes = 0;
  const expandedEntries = new Map<string, Buffer>();
  for (const entry of entries) {
    let expandedEntryBytes = 0;
    const entryChunks: Buffer[] = [];
    const stream = (entry as typeof entry & {
      internalStream(type: 'uint8array'): ZipByteStream;
    }).internalStream('uint8array');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        stream.pause();
        reject(error);
      };
      stream.on('data', (chunk: Uint8Array) => {
        expandedEntryBytes += chunk.byteLength;
        expandedWorkbookBytes += chunk.byteLength;
        if (expandedEntryBytes > maxExpandedEntryBytes || expandedWorkbookBytes > maxExpandedWorkbookBytes) {
          fail(new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha expandida excede o limite seguro.', false));
          return;
        }
        entryChunks.push(Buffer.from(chunk));
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      stream.resume();
    });
    expandedEntries.set(entry.name, Buffer.concat(entryChunks, expandedEntryBytes));
  }
  return expandedEntries;
}

async function orderedWorkbookBytes(entries: Map<string, Buffer>) {
  const priority = ['xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml'];
  const names = [...entries.keys()].sort((left, right) => {
    const leftPriority = priority.indexOf(left);
    const rightPriority = priority.indexOf(right);
    if (leftPriority >= 0 || rightPriority >= 0) {
      return (leftPriority < 0 ? priority.length : leftPriority) -
        (rightPriority < 0 ? priority.length : rightPriority);
    }
    return left.localeCompare(right);
  });
  const archive = new JSZip();
  for (const name of names) archive.file(name, entries.get(name)!, { binary: true });
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function parseClientWorkbook(sourceName: string, bytes: Uint8Array): Promise<ClientImportPreview> {
  if (!sourceName.toLowerCase().endsWith('.xlsx')) {
    throw new RouteRequestError(415, 'VALIDATION_FAILED', 'Envie um arquivo .xlsx.', false);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxFileBytes) {
    throw new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha deve ter até 5 MiB.', false);
  }
  const expandedEntries = await assertBoundedWorkbookArchive(bytes);
  const streamingBytes = await orderedWorkbookBytes(expandedEntries);
  const issues: ClientImportIssue[] = [];
  const rows: ClientImportRow[] = [];
  const seen = new Set<string>();
  let worksheetFound = false;
  let headerFound = false;
  let dataRowsSeen = 0;
  try {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(streamingBytes), {
      worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', entries: 'ignore',
    });
    // ExcelJS can encounter a worksheet before workbook.xml in otherwise valid ZIP order.
    // Initializing the optional metadata avoids materializing the workbook only to obtain a sheet name.
    (workbook as unknown as { model: { sheets: unknown[] } }).model = { sheets: [] };
    for await (const worksheet of workbook) {
      worksheetFound = true;
      for await (const row of worksheet) {
        const rowNumber = row.number;
        if (rowNumber === 1) {
          headerFound = true;
          const headerValues = clientImportHeaders.map((_, index) =>
            text(cellValue(row.getCell(index + 1)).value).toLowerCase());
          clientImportHeaders.forEach((expected, index) => {
            if (headerValues[index] !== expected) {
              issues.push(issue(1, 'INVALID_HEADER', `Cabeçalho ${index + 1} deve ser ${expected}.`));
            }
          });
          if (issues.length > 0) break;
          continue;
        }
        if (!headerFound) break;
        const cells = clientImportHeaders.map((_, index) => cellValue(row.getCell(index + 1)));
        if (cells.every((cell) => !cell.formula && cell.value === '')) continue;
        dataRowsSeen += 1;
        if (dataRowsSeen > maxRows) {
          throw new RouteRequestError(422, 'VALIDATION_FAILED', `A planilha aceita no máximo ${maxRows} clientes.`, false);
        }
        const rowIssues: ClientImportIssue[] = [];
        cells.forEach((cell, index) => {
          if (cell.formula) rowIssues.push(issue(rowNumber, 'FORMULA_NOT_ALLOWED', `Fórmula não permitida em ${clientImportHeaders[index]}.`));
          const value = text(cell.value);
          if (textualColumns.has(index) && /^[=+\-@]/.test(value)) {
            rowIssues.push(issue(rowNumber, 'FORMULA_TEXT_NOT_ALLOWED', `Conteúdo inseguro em ${clientImportHeaders[index]}.`));
          }
        });
        const externalReference = text(cells[0]!.value);
        const name = text(cells[1]!.value);
        const address = text(cells[2]!.value);
        const latitude = coordinate(cells[3]!.value, -90, 90);
        const longitude = coordinate(cells[4]!.value, -180, 180);
        const portfolioReference = text(cells[5]!.value) || null;
        const sellerEmail = text(cells[6]!.value).toLowerCase();
        const statusText = text(cells[7]!.value).toLowerCase() || 'active';
        if (!externalReference || !name || !address || !sellerEmail) rowIssues.push(issue(rowNumber, 'REQUIRED_FIELD', 'Referência, nome, endereço e vendedor são obrigatórios.'));
        if (latitude.error || longitude.error || (latitude.value === null) !== (longitude.value === null)) {
          rowIssues.push(issue(rowNumber, 'INVALID_COORDINATES', 'Latitude e longitude devem ser válidas e informadas juntas.'));
        }
        if (!['active', 'archived'].includes(statusText)) rowIssues.push(issue(rowNumber, 'INVALID_STATUS', 'Status deve ser active ou archived.'));
        if (seen.has(externalReference.toLowerCase())) rowIssues.push(issue(rowNumber, 'DUPLICATE_REFERENCE', 'Referência repetida no arquivo.'));
        seen.add(externalReference.toLowerCase());
        const parsed = clientImportRowSchema.safeParse({ rowNumber, externalReference, name, address,
          latitude: latitude.value, longitude: longitude.value, portfolioReference, sellerEmail, status: statusText });
        if (!parsed.success && rowIssues.length === 0) rowIssues.push(issue(rowNumber, 'INVALID_ROW', 'Revise os campos desta linha.'));
        if (rowIssues.length > 0 || !parsed.success) issues.push(...rowIssues);
        else rows.push(parsed.data);
      }
      break;
    }
  } catch (error) {
    if (error instanceof RouteRequestError) throw error;
    const failure = new RouteRequestError(422, 'VALIDATION_FAILED', 'A planilha Excel não pôde ser lida.', false);
    failure.cause = error;
    throw failure;
  }
  if (!worksheetFound) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'A planilha não possui uma aba de dados.', false);
  if (!headerFound) {
    clientImportHeaders.forEach((expected, index) =>
      issues.push(issue(1, 'INVALID_HEADER', `Cabeçalho ${index + 1} deve ser ${expected}.`)));
  }
  if (issues.some((item) => item.rowNumber === 1)) return clientImportPreviewSchema.parse({
    schemaVersion: 1, sourceName, sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
    totalCount: 0, acceptedCount: 0, rejectedCount: 0, rows: [], issues,
  });
  const rejectedRows = new Set(issues.filter((item) => item.rowNumber > 1).map((item) => item.rowNumber)).size;
  return clientImportPreviewSchema.parse({
    schemaVersion: 1, sourceName, sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
    totalCount: rows.length + rejectedRows, acceptedCount: rows.length, rejectedCount: rejectedRows, rows, issues,
  });
}

export async function readClientImportFile(request: Request) {
  const advertisedLength = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isFinite(advertisedLength) || advertisedLength > maxRequestBytes) {
    throw new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha deve ter até 5 MiB.', false);
  }
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new RouteRequestError(415, 'VALIDATION_FAILED', 'Envie a planilha como multipart/form-data.', false);
  }
  if (!request.body) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Selecione uma planilha Excel.', false);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxRequestBytes) {
      await reader.cancel();
      throw new RouteRequestError(413, 'VALIDATION_FAILED', 'A planilha deve ter até 5 MiB.', false);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let form: FormData;
  try {
    form = await new Response(Buffer.from(body), { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new RouteRequestError(422, 'VALIDATION_FAILED', 'O envio da planilha está malformado.', false);
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new RouteRequestError(422, 'VALIDATION_FAILED', 'Selecione uma planilha Excel.', false);
  return parseClientWorkbook(file.name, new Uint8Array(await file.arrayBuffer()));
}
