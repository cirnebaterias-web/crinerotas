import { expect, it } from 'vitest';
import { stockInsightsCatalogSchema, stockInsightsInputSchema, stockInsightsSchema } from './stock-insights';

const valid = {
  snapshot: { heliarQuantity: 0, mouraQuantity: 0, ownLines: [], competitorLines: [] },
  publishedCatalogVersion: 2,
  catalogs: [{ version: 2, products: [{ code: 'synthetic', brand: 'Heliar', model: 'Modelo', amperageAh: null, technology: null }] }],
};
it('retains the distinction between absent and empty line arrays', () => {
  const legacy = { ...valid, snapshot: { heliarQuantity: 4, mouraQuantity: 7 } };
  expect(stockInsightsInputSchema.parse(legacy).snapshot.ownLines).toBeUndefined();
  expect(stockInsightsInputSchema.parse(valid).snapshot.ownLines).toEqual([]);
});
it('accepts unclassifiable catalog metadata, retains provenance, and rejects invalid Ah', () => {
  expect(stockInsightsCatalogSchema.parse({ ...valid.catalogs[0], provenance: 'synthetic' })).toHaveProperty('provenance', 'synthetic');
  const invalid = structuredClone(valid); invalid.catalogs[0]!.products[0]!.amperageAh = -1 as never;
  expect(stockInsightsInputSchema.safeParse(invalid).success).toBe(false);
});
it('rejects invalid snapshots and missing published registry without manufacturing analysis', () => {
  expect(stockInsightsInputSchema.safeParse({ ...valid, snapshot: { ...valid.snapshot, heliarQuantity: -1 } }).success).toBe(false);
  expect(stockInsightsInputSchema.safeParse({ ...valid, catalogs: [] }).success).toBe(false);
  expect(stockInsightsSchema.safeParse({}).success).toBe(false);
});
