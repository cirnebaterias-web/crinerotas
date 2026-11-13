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

const insufficientOutput = {
  schemaVersion: 1,
  overall: { state: 'insufficient', ownUnits: null, rivalUnits: 7, totalUnits: null, ownSharePercent: null, rivalSharePercent: null },
  pairs: ['heliar-moura', 'america-zetta', 'durex-economy'].map((id) => ({
    id, label: 'Par sintético', ownBrand: 'Heliar', state: 'insufficient', ownUnits: null, rivalUnits: null,
    totalUnits: null, differenceUnits: null, ownSharePercent: null, rivalSharePercent: null, cuts: [],
  })),
  opportunities: [], readingState: 'insufficient',
  coverage: { general: { ownLinesAvailable: false, rivalLinesAvailable: true, observed: { lines: 1, units: 7 } },
    analytical: { included: { lines: 1, units: 7 }, excluded: { lines: 0, units: 0 }, reasons: [] },
    partial: true, legacy: { heliarQuantity: 0, mouraQuantity: 7, usedInTotals: false } },
  caution: 'Estoque observado.',
};
it('validates unavailable pair quantities as null and rejects synthetic zeroes in incomplete comparisons', () => {
  expect(stockInsightsSchema.safeParse(insufficientOutput).success).toBe(true);
  for (const field of ['ownUnits', 'rivalUnits', 'totalUnits', 'differenceUnits', 'ownSharePercent', 'rivalSharePercent']) {
    const invalid = structuredClone(insufficientOutput);
    Object.assign(invalid.pairs[0]!, { [field]: 0 });
    expect(stockInsightsSchema.safeParse(invalid).success).toBe(false);
  }
});
it('rejects cuts or opportunities with incomplete arrays and requires complete arrays for quantitative pairs', () => {
  const invalidCut = structuredClone(insufficientOutput);
  Object.assign(invalidCut.pairs[0]!, { cuts: [{ pairId: 'heliar-moura', amperageAh: 60, family: 'SLI',
    ownUnits: 0, rivalUnits: 7, totalUnits: 7, differenceUnits: -7, ownSharePercent: 0, rivalSharePercent: 100 }] });
  expect(stockInsightsSchema.safeParse(invalidCut).success).toBe(false);
  const invalidOpportunity = structuredClone(insufficientOutput);
  Object.assign(invalidOpportunity, { opportunities: [{ pairId: 'heliar-moura', ownBrand: 'Heliar',
    amperageAh: 60, family: 'SLI', kind: 'absence', ownUnits: 0, rivalUnits: 7, gapUnits: 7, models: [] }] });
  expect(stockInsightsSchema.safeParse(invalidOpportunity).success).toBe(false);
  const invalidPair = structuredClone(insufficientOutput);
  Object.assign(invalidPair.pairs[0]!, { state: 'available', ownUnits: 0, rivalUnits: 7,
    totalUnits: 7, differenceUnits: -7, ownSharePercent: 0, rivalSharePercent: 100 });
  expect(stockInsightsSchema.safeParse(invalidPair).success).toBe(false);
  const completeArrays = structuredClone(insufficientOutput);
  completeArrays.coverage.general.ownLinesAvailable = true;
  expect(stockInsightsSchema.safeParse(completeArrays).success).toBe(false);
});
