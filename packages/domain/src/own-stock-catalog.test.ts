import { describe, expect, it } from 'vitest';
import { stockInsightsCatalogSchema } from '@cirne/contracts';
import { supportedStockInsightsCatalogs, GENERATED_STOCK_CATALOG_PROVENANCE } from './own-stock-catalog';

describe('shared offline stock catalog', () => {
  it('keeps verified v2 identity and canonical source metadata offline', () => {
    expect(supportedStockInsightsCatalogs.publishedCatalogVersion).toBe(2);
    expect(supportedStockInsightsCatalogs.catalogs.map((catalog) => catalog.version)).toEqual([2]);
    const catalog = supportedStockInsightsCatalogs.catalogs.find((entry) => entry.version === 2);
    if (!catalog) throw new Error('Verified catalog v2 must remain available offline.');
    const products = catalog.products;
    expect(products).toHaveLength(156);
    expect(new Set(products.map((product) => product.code)).size).toBe(156);
    expect(products.every((product) => product.amperageAh > 0)).toBe(true);
    expect(new Set(products.map((product) => product.technology))).toEqual(new Set(['SLI', 'EFB', 'AGM']));
    expect(products.every((product) => product.weightSource === 'catalog')).toBe(true);
    expect(GENERATED_STOCK_CATALOG_PROVENANCE.identitySha256)
      .toBe('fe931fee8fc34c08ec18e6690a2e295a744e0c261c72207f8cb6874241d3be13');
    expect(GENERATED_STOCK_CATALOG_PROVENANCE.verifiedPublishedIdentitySha256)
      .toBe(GENERATED_STOCK_CATALOG_PROVENANCE.identitySha256);
    expect(stockInsightsCatalogSchema.safeParse(catalog).success).toBe(true);
  });
});
