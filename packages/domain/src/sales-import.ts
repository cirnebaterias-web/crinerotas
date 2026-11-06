import { maxSalesRows, salesImportRowSchema, salesSheetHeaders, type SalesImportRow } from '@cirne/contracts';

export const salesProjectionFields = [
  'clientExternalReference', 'invoiceNumber', 'saleDate', 'sku', 'volume', 'totalAmount',
  'productDescription', 'itemGroup', 'itemSubgroup', 'category', 'brand', 'line', 'kind', 'externalKey',
] as const;
export type SalesProjectedRow = {
  sourceRow: number;
  cells: Record<(typeof salesProjectionFields)[number], unknown>;
};
export type SalesSourceIssue = { row: number; code: 'INVALID_ROW' | 'DUPLICATE_KEY' | 'DUPLICATE_ROW' };
export class SalesSourceValidationError extends Error {
  constructor(public readonly code: 'SOURCE_INVALID' | 'SOURCE_TOO_LARGE',
    public readonly issues: readonly SalesSourceIssue[] = []) {
    super('Não foi possível validar o histórico de vendas. A geração anterior foi preservada.');
    this.name = 'SalesSourceValidationError';
  }
}

export function validateSalesHeaders(headers: readonly unknown[]): void {
  if (headers.length !== salesSheetHeaders.length || headers.some((value, index) =>
    typeof value !== 'string' || value.trim() !== salesSheetHeaders[index]?.trim())) {
    throw new SalesSourceValidationError('SOURCE_INVALID');
  }
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return value.trim().normalize('NFC');
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (value === undefined || value === null) return '';
  throw new SalesSourceValidationError('SOURCE_INVALID');
}

export function normalizeSalesDate(value: unknown): string {
  const match = plainText(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new SalesSourceValidationError('SOURCE_INVALID');
  const [, day, month, year] = match;
  const iso = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  // Compare calendar fields: Date's permissive rollover is never accepted.
  const parsed = new Date(`${iso}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso
      || Number(year) < 1900 || Number(year) > 9999) throw new SalesSourceValidationError('SOURCE_INVALID');
  return iso;
}

export function normalizeSalesMoney(value: unknown): string {
  let input: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SalesSourceValidationError('SOURCE_INVALID');
    input = String(value);
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(input)) throw new SalesSourceValidationError('SOURCE_INVALID');
  } else {
    input = plainText(value);
    if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(input)) {
      throw new SalesSourceValidationError('SOURCE_INVALID');
    }
    input = input.replaceAll('.', '').replace(',', '.');
  }
  const negative = input.startsWith('-');
  const [whole = '', fraction = ''] = input.replace(/^-/, '').split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimal = fraction.padEnd(2, '0');
  if (integer.length > 10) throw new SalesSourceValidationError('SOURCE_INVALID');
  return `${negative && (integer !== '0' || decimal !== '00') ? '-' : ''}${integer}.${decimal}`;
}

function quantity(value: unknown): number {
  const canonical = normalizeSalesMoney(value);
  if (!canonical.endsWith('.00')) throw new SalesSourceValidationError('SOURCE_INVALID');
  return Number(canonical.slice(0, -3));
}

function documentReference(value: unknown): string {
  const input = plainText(value);
  if (!/^[\d.\-/\s]+$/.test(input)) throw new SalesSourceValidationError('SOURCE_INVALID');
  return input.replace(/\D/g, '');
}

/** A failed source exposes no partial set of accepted rows to the caller. */
export function normalizeSalesRows(input: readonly SalesProjectedRow[]): SalesImportRow[] {
  if (input.length > maxSalesRows) throw new SalesSourceValidationError('SOURCE_TOO_LARGE');
  const rows: SalesImportRow[] = [];
  const issues: SalesSourceIssue[] = [];
  const keys = new Set<string>();
  const positions = new Set<number>();
  let invalid = false;
  const issue = (row: number, code: SalesSourceIssue['code']) => {
    invalid = true;
    if (issues.length < 50) issues.push({ row: Number.isSafeInteger(row) ? row : 0, code });
  };
  for (const projected of input) {
    if (!projected || typeof projected !== 'object' || !projected.cells
        || typeof projected.cells !== 'object' || Array.isArray(projected.cells)) {
      issue(0, 'INVALID_ROW'); continue;
    }
    const { sourceRow, cells } = projected;
    // Empty gaps are not transactions; preserve sourceRow for all actual records.
    if (salesProjectionFields.every((key) => cells[key] === undefined || cells[key] === null
        || (typeof cells[key] === 'string' && cells[key].trim() === ''))) continue;
    try {
      const operation = plainText(cells.kind).toLocaleLowerCase('pt-BR');
      const parsed = salesImportRowSchema.safeParse({
        sourceRow, externalKey: plainText(cells.externalKey),
        clientExternalReference: documentReference(cells.clientExternalReference),
        invoiceNumber: plainText(cells.invoiceNumber), saleDate: normalizeSalesDate(cells.saleDate),
        sku: plainText(cells.sku), productDescription: plainText(cells.productDescription),
        itemGroup: plainText(cells.itemGroup), itemSubgroup: plainText(cells.itemSubgroup),
        category: plainText(cells.category), brand: plainText(cells.brand), line: plainText(cells.line),
        kind: operation === 'venda' ? 'sale' : operation === 'devolução' ? 'return' : null,
        volume: quantity(cells.volume), totalAmount: normalizeSalesMoney(cells.totalAmount),
      });
      if (!parsed.success) { issue(sourceRow, 'INVALID_ROW'); continue; }
      const row = parsed.data;
      if (keys.has(row.externalKey)) issue(sourceRow, 'DUPLICATE_KEY');
      if (positions.has(row.sourceRow)) issue(sourceRow, 'DUPLICATE_ROW');
      keys.add(row.externalKey); positions.add(row.sourceRow); rows.push(row);
    } catch {
      issue(sourceRow, 'INVALID_ROW');
    }
  }
  if (invalid || rows.length === 0) throw new SalesSourceValidationError('SOURCE_INVALID', issues);
  return rows.sort((left, right) => left.sourceRow - right.sourceRow);
}

/** Shared canonical ordering, mirrored by the SQL scalar-JSON concatenation. */
export function salesRowTuple(row: SalesImportRow): readonly (string | number)[] {
  return [row.sourceRow, row.externalKey, row.clientExternalReference, row.invoiceNumber, row.saleDate,
    row.sku, row.productDescription, row.itemGroup, row.itemSubgroup, row.category, row.brand, row.line,
    row.kind, row.volume, row.totalAmount];
}
