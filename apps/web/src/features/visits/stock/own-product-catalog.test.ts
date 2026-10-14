import { describe, expect, it } from 'vitest';
import {
  COMPETITOR_STOCK_BRANDS,
  COMPETITOR_STOCK_TECHNOLOGIES,
  OWN_STOCK_BRANDS,
  ownProductCatalog,
  ownProductItems,
  stockWeightKg,
  stockCatalog,
} from './own-product-catalog';

describe('own stock catalog preview', () => {
  it('includes every distinct model in the supplied Clarios base without duplicates', () => {
    expect(OWN_STOCK_BRANDS).toEqual(['Heliar', 'América', 'Durex', 'ACDelco']);
    expect(Object.fromEntries(OWN_STOCK_BRANDS.map((brand) => [brand, ownProductCatalog[brand].length]))).toEqual({
      Heliar: 99, América: 19, Durex: 6, ACDelco: 22,
    });
    for (const brand of OWN_STOCK_BRANDS) {
      expect(new Set(ownProductCatalog[brand]).size).toBe(ownProductCatalog[brand].length);
    }
  });

  it('publishes the commercially approved stock catalog as version 2', () => {
    expect(stockCatalog).toMatchObject({
      schemaVersion: 1,
      version: 2,
      validFrom: '2026-10-02',
      status: 'published',
    });
    expect(COMPETITOR_STOCK_BRANDS).toEqual(['Moura', 'Zetta', 'Bosh', 'Tudor', 'Pioneiro']);
    expect(COMPETITOR_STOCK_TECHNOLOGIES).toEqual(['SLI', 'EFB', 'AGM']);
    expect(stockCatalog.ownModels).toBe(ownProductCatalog);
  });

  it('publishes all rows by factory code and calculates exact snapshot weights', () => {
    expect(ownProductItems).toHaveLength(156);
    expect(new Set(ownProductItems.map((item) => item.id)).size).toBe(156);
    expect(ownProductItems.filter((item) => item.brand === 'Heliar')).toHaveLength(109);
    expect(ownProductItems.every((item) => Number(item.unitWeightKg) > 0)).toBe(true);
    expect(stockWeightKg([
      { brand: 'Heliar', model: 'A', quantity: 2, unitWeightKg: '18.7', weightSource: 'catalog' },
      { brand: 'América', model: 'Sem cadastro', quantity: 3, weightSource: 'fallback_15kg' },
    ])).toBe(82.4);
  });
});
