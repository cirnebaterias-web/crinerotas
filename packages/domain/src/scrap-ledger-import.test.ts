import { describe, expect, it } from 'vitest';
import { normalizeScrapLedgerRows, ScrapLedgerSourceError } from './scrap-ledger-import';

describe('scrap ledger import', () => {
  it('classifies impossible calendar dates as an invalid source', () => {
    expect(() => normalizeScrapLedgerRows([{ sourceRow: 2, cells: {
      operation: 'débito',
      clientExternalReference: '12345678000199',
      occurredOn: '32/13/2026',
      sourceWeightKg: '10',
      signedWeightKg: '-10',
    } }])).toThrow(ScrapLedgerSourceError);

    try {
      normalizeScrapLedgerRows([{ sourceRow: 2, cells: {
        operation: 'débito', clientExternalReference: '12345678000199',
        occurredOn: '32/13/2026', sourceWeightKg: '10', signedWeightKg: '-10',
      } }]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'SOURCE_INVALID' });
    }
  });
});
