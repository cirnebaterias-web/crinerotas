import { describe, expect, it } from 'vitest';
import { findCatalogPriceRow } from './visit-competitor-prices-step';

describe('findCatalogPriceRow', () => {
  const rows = [
    { rowId: 'first', productCode: 'SKU-001', modelOrAmperage: 'MODELO REPETIDO' },
    { rowId: 'second', productCode: 'SKU-002', modelOrAmperage: 'MODELO REPETIDO' },
    { rowId: 'legacy', modelOrAmperage: 'MODELO LEGADO' },
  ];

  it('keeps catalog products with the same model independent by product code', () => {
    expect(findCatalogPriceRow(rows, 'SKU-001', 'MODELO REPETIDO')?.rowId).toBe('first');
    expect(findCatalogPriceRow(rows, 'SKU-002', 'MODELO REPETIDO')?.rowId).toBe('second');
  });

  it('uses the model fallback only for rows without a product code', () => {
    expect(findCatalogPriceRow(rows, 'SKU-LEGACY', 'modelo legado')?.rowId).toBe('legacy');
    expect(findCatalogPriceRow(rows, 'SKU-003', 'MODELO REPETIDO')).toBeUndefined();
  });
});
