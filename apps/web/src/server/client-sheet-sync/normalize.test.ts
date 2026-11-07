import { describe, expect, it } from 'vitest';
import { clientSheetHeaders } from '@cirne/contracts';
import { normalizeClientSheet } from './normalize';
const mapping = { TESTE: 'seller@example.invalid' };
function row(patch: Record<number, unknown> = {}) {
  const cells: unknown[] = ['Cliente Sintético', '01.234.567/0001-99', '', 'TESTE', 'ATIVO', '', '', '-5,1234567', '-35,1234567', 'Rua Sintética, 10'];
  for (const [index, value] of Object.entries(patch)) cells[Number(index)] = value;
  return cells;
}
const parse = (...rows: unknown[][]) => normalizeClientSheet([[...clientSheetHeaders], ...rows], mapping);
describe('Google client sheet normalization', () => {
  it('imports Q/U/P/R separately without requiring coordinates or overwriting the cadastral address', () => {
    const result = parse(row({ 7: '', 8: '', 15: 'REVISAR_ENDERECO_PARCIAL', 16: 'Rua Google, 22', 17: 'RANGE_INTERPOLATED', 20: 'EjR_Address-123' }));
    expect(result.preview.rows[0]).toMatchObject({ address: 'Rua Sintética, 10', latitude: null, longitude: null,
      googleLocation: { address: 'Rua Google, 22', placeId: 'EjR_Address-123', status: 'REVISAR_ENDERECO_PARCIAL', precision: 'RANGE_INTERPOLATED' } });
  });
  it('sends all nulls to clear removed Google source fields', () => {
    expect(parse(row()).preview.rows[0]?.googleLocation).toEqual({ address: null, placeId: null, status: null, precision: null });
  });
  it.each([{ 20: 'https://evil.invalid/' }, { 20: 'x'.repeat(513) }, { 16: '=HYPERLINK("x")' }, { 16: { formula: 'x' } }])('keeps malformed Google metadata pending for review', (patch) => {
    expect(parse(row(patch)).preview).toMatchObject({ acceptedCount: 0, rejectedCount: 1,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'GOOGLE_LOCATION_PENDING_REVIEW' })]) });
  });
  it('maps only canonical fields and preserves identifier leading zeros', () => {
    const result = parse(row());
    expect(result.preview.rows[0]).toMatchObject({ externalReference: '01234567000199',
      name: 'Cliente Sintético', latitude: -5.1234567, sellerEmail: mapping.TESTE, status: 'active' });
    expect(result.preview.acceptedCount).toBe(1);
  });
  it('ignores OUTROS before any other validation', () => {
    const result = parse(row({ 0: '', 1: '', 3: ' outros ', 4: '', 7: 'invalid' }));
    expect(result.ignoredCount).toBe(1);
    expect(result.preview).toMatchObject({ totalCount: 0, rejectedCount: 0, rows: [], issues: [] });
  });
  it('ignores rows populated only in unsupported auxiliary columns', () => {
    const auxiliaryOnly: unknown[] = Array.from({ length: clientSheetHeaders.length }, () => '');
    auxiliaryOnly[10] = 'Tipo auxiliar';
    auxiliaryOnly[12] = { formula: '1+1', result: 'Não usado' };
    expect(normalizeClientSheet([[...clientSheetHeaders], auxiliaryOnly], mapping).preview)
      .toMatchObject({ totalCount: 0, acceptedCount: 0, rejectedCount: 0, rows: [], issues: [] });
  });
  it.each(['', '0', 'Sim', 'SEM CLASSIFICAÇÃO', 'desconhecido'])('keeps status %s pending, never active', (status) => {
    const result = parse(row({ 4: status }));
    expect(result.preview.rows).toHaveLength(0);
    expect(result.preview.issues[0]?.code).toBe('STATUS_PENDING_REVIEW');
  });
  it('recognizes inactive and empty coordinate pairs', () => {
    expect(parse(row({ 4: ' inativo ', 7: '', 8: '' })).preview.rows[0]).toMatchObject({ status: 'archived', latitude: null, longitude: null });
  });
  it.each(['', 'VERIFICAR', 'SEM MAPA', 'constructor'])('does not infer seller for %s', (portfolio) => {
    expect(parse(row({ 3: portfolio })).preview.issues[0]?.code).toBe('PORTFOLIO_PENDING_REVIEW');
  });
  it('marks every duplicate occurrence pending, including differently formatted IDs', () => {
    const result = parse(row(), row({ 1: '01234567000199' }));
    expect(result.preview).toMatchObject({ acceptedCount: 0, rejectedCount: 2 });
    expect(result.preview.issues.every((issue) => issue.code === 'DUPLICATE_REFERENCE')).toBe(true);
  });
  it.each([{ 7: '-91' }, { 8: '' }, { 7: 'x' }, { 0: '=HYPERLINK("x")' }, { 9: '' }, { 1: '12' }])('rejects invalid canonical inputs', (patch) => {
    expect(parse(row(patch)).preview.acceptedCount).toBe(0);
  });
  it('accepts calculated Google values as values without evaluating formula objects', () => {
    expect(parse(row({ 9: { formula: 'malicious' } })).preview.acceptedCount).toBe(0);
  });
  it('rejects formula cells in every canonical field used by the importer', () => {
    expect(parse(row({ 7: { formula: '1+1', result: -5 }, 8: { formula: '1+1', result: -35 } })).preview)
      .toMatchObject({ acceptedCount: 0, rejectedCount: 1,
        issues: [expect.objectContaining({ code: 'FORMULA_NOT_ALLOWED' })] });
  });
  it('rejects wrong headers and excess rows without partial import', () => {
    expect(() => normalizeClientSheet([['nome']], mapping)).toThrow('21 cabeçalhos');
    expect(() => parse(...Array.from({ length: 5001 }, () => []))).toThrow('5.000');
  });
  it('bounds issue count for 5,000 invalid rows and ignores blank rows', () => {
    const result = parse(...Array.from({ length: 5000 }, () => row({ 0: '', 1: '', 3: '', 4: '' })));
    expect(result.preview.rejectedCount).toBe(5000);
    expect(result.preview.issues.length).toBeLessThanOrEqual(10000);
    expect(parse([]).preview.totalCount).toBe(0);
  });
});
