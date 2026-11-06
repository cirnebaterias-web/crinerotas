import { describe, expect, it } from 'vitest';
import { salesSheetHeaders } from '@cirne/contracts';
import { normalizeSalesDate, normalizeSalesMoney, normalizeSalesRows, salesRowTuple,
  SalesSourceValidationError, validateSalesHeaders, type SalesProjectedRow } from './sales-import';

function fixture(overrides: Partial<SalesProjectedRow['cells']> = {}): SalesProjectedRow {
  return { sourceRow: 2, cells: {
    clientExternalReference: '00.000.000/0001-91', invoiceNumber: '0001', saleDate: '5/12/2023',
    sku: '00042', volume: '12', totalAmount: '4.092,00', productDescription: 'Bateria exemplo',
    itemGroup: 'SLI', itemSubgroup: '60', category: 'Leve', brand: 'Marca teste', line: 'Linha teste',
    kind: 'Venda', externalKey: 'synthetic-line-1', ...overrides,
  } };
}
describe('sales source normalization', () => {
  it('validates the full official header without asking for cost values', () => {
    expect(() => validateSalesHeaders(salesSheetHeaders)).not.toThrow();
    expect(() => validateSalesHeaders([...salesSheetHeaders, 'Extra'])).toThrow(SalesSourceValidationError);
    expect(() => validateSalesHeaders(salesSheetHeaders.map((h) => h === 'Volume' ? 'Quantidade Geral' : h))).toThrow();
  });
  it('preserves leading zeroes and converts only projected fields', () => {
    const [row] = normalizeSalesRows([fixture()]);
    expect(row).toMatchObject({ clientExternalReference: '00000000000191', invoiceNumber: '0001',
      sku: '00042', saleDate: '2023-12-05', volume: 12, totalAmount: '4092.00', kind: 'sale' });
    expect(Object.keys(row!)).toHaveLength(15);
    expect(salesRowTuple(row!)).toEqual([2, 'synthetic-line-1', '00000000000191', '0001', '2023-12-05',
      '00042', 'Bateria exemplo', 'SLI', '60', 'Leve', 'Marca teste', 'Linha teste', 'sale', 12, '4092.00']);
  });
  it.each(['1/2/2024', '01/02/2024'])('uses day-first date %s', (input) => {
    expect(normalizeSalesDate(input)).toBe('2024-02-01');
  });
  it.each(['29/2/2023', '31/4/2026', '2026-03-05', '1/13/2026', '12/12/1899', '01/01/10000', '', 'today'])
    ('rejects invalid/ambiguous dates %s', (input) => expect(() => normalizeSalesDate(input)).toThrow());
  it('accepts leap day and handles non-ISO number formatting exactly', () => {
    expect(normalizeSalesDate('29/2/2024')).toBe('2024-02-29');
    expect(normalizeSalesMoney('1.234.567,89')).toBe('1234567.89');
    expect(normalizeSalesMoney('-0,00')).toBe('0.00');
    expect(normalizeSalesMoney(12.34)).toBe('12.34');
    expect(normalizeSalesMoney('00012,3')).toBe('12.30');
  });
  it.each(['12.34', '1,234', 'R$ 2,00', 'NaN', '1e2', '10000000000', '', '1 200,00', Infinity, 1.001])
    ('rejects malformed/out-of-range amounts %s', (input) => expect(() => normalizeSalesMoney(input)).toThrow());
  it('keeps negative returns; never takes absolute quantity', () => {
    expect(normalizeSalesRows([fixture({ kind: 'Devolução', volume: '-13', totalAmount: '-3.198,00' })])[0])
      .toMatchObject({ kind: 'return', volume: -13, totalAmount: '-3198.00' });
  });
  it.each([
    { volume: '-1' }, { volume: '0' }, { volume: '1,5' }, { volume: '1000001' },
    { totalAmount: '-1,00' }, { kind: 'Devolução' }, { kind: 'Devolução', volume: '-1', totalAmount: '1,00' },
    { kind: 'Cancelado' }, { clientExternalReference: 'abc00000000000191' }, { clientExternalReference: '123' },
    { sku: '=IMPORTXML(...)' }, { productDescription: 'Linha\u0000privada' }, { externalKey: '' }, { invoiceNumber: '' },
  ])('fails the entire source for bad canonical row %o', (overrides) => {
    expect(() => normalizeSalesRows([fixture(overrides)])).toThrow(SalesSourceValidationError);
  });
  it('rejects duplicates rather than silently deduplicating or adding them', () => {
    expect(() => normalizeSalesRows([fixture(), { ...fixture(), sourceRow: 3 }])).toThrow();
    expect(() => normalizeSalesRows([fixture(), fixture({ externalKey: 'another' })])).toThrow();
  });
  it('rejects empty sources and never returns valid rows from an invalid source', () => {
    expect(() => normalizeSalesRows([])).toThrow();
    const invalid = { ...fixture({ clientExternalReference: 'sensitive-raw-value', externalKey: 'other' }), sourceRow: 3 };
    try { normalizeSalesRows([fixture(), invalid]); expect.fail('must reject'); }
    catch (error) {
      expect(error).toBeInstanceOf(SalesSourceValidationError);
      expect(JSON.stringify(error)).not.toContain('sensitive-raw-value');
      expect((error as SalesSourceValidationError).issues).toEqual([{ row: 3, code: 'INVALID_ROW' }]);
    }
  });
  it('sorts actual source positions and ignores fully blank gaps', () => {
    const gap: SalesProjectedRow = { sourceRow: 3, cells: Object.fromEntries(
      Object.keys(fixture().cells).map((key) => [key, '']),
    ) as SalesProjectedRow['cells'] };
    const result = normalizeSalesRows([{ ...fixture({ externalKey: 'later' }), sourceRow: 4 }, gap, fixture()]);
    expect(result.map((r) => r.sourceRow)).toEqual([2, 4]);
  });
  it('supports a complete source larger than the observed source without truncation', () => {
    const input = Array.from({ length: 26_500 }, (_, i) => ({ ...fixture({ externalKey: `synthetic-${i}` }), sourceRow: i + 2 }));
    expect(normalizeSalesRows(input)).toHaveLength(26_500);
  }, 15_000);
});
