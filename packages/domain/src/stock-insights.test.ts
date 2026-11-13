import { describe, expect, it } from 'vitest';
import { stockInsightsSchema, type StockInsightsInput, type StockInsightsProduct, type OwnStockLine, type CompetitorStockLine } from '@cirne/contracts';
import { analyzeStockInsights, stockInsightsTechnologyFamily } from './stock-insights';

const product = (code: string, brand: StockInsightsProduct['brand'] = 'Heliar', amperageAh: number | null = 60, technology: string | null = 'SLI'): StockInsightsProduct =>
  ({ code, brand, model: 'Mesmo modelo', amperageAh, technology });
const own = (quantity: number, extra: Partial<OwnStockLine> = {}): OwnStockLine =>
  ({ brand: 'Heliar', model: 'Nome não usado 999Ah', quantity, productCode: 'h60', catalogVersion: 2, ...extra });
const rival = (quantity: number, extra: Partial<CompetitorStockLine> = {}): CompetitorStockLine =>
  ({ brand: 'Moura', amperage: 60, technology: 'SLI', quantity, ...extra });
const input = (ownLines: OwnStockLine[] = [], competitorLines: CompetitorStockLine[] = []): StockInsightsInput => ({
  snapshot: { heliarQuantity: 900, mouraQuantity: 900, ownLines, competitorLines }, publishedCatalogVersion: 2,
  catalogs: [{ version: 2, products: [product('h60'), product('h60b'), product('a60', 'América'), product('d60', 'Durex')] }],
});

describe('stock insights: observed units and identity', () => {
  it('uses only lines for overall and the three independent commercial denominators', () => {
    const data = input([own(10), own(5, { brand: 'América', productCode: 'a60' }), own(2, { brand: 'Durex', productCode: 'd60' }),
      own(3, { brand: 'ACDelco', productCode: undefined })], [rival(10), rival(5, { brand: 'Zetta' }),
      rival(1, { brand: 'Pioneiro' }), rival(2, { brand: 'Outra', otherBrand: ' PIOBAT ' }),
      rival(1, { brand: 'Outra', otherBrand: 'Eletran' }), rival(11, { brand: 'Tudor' })]);
    const result = analyzeStockInsights(data);
    expect(result.overall).toMatchObject({ ownUnits: 20, rivalUnits: 30, totalUnits: 50, ownSharePercent: 40 });
    expect(result.pairs.map((pair) => [pair.ownUnits, pair.rivalUnits])).toEqual([[10, 10], [5, 5], [2, 4]]);
    expect(result.pairs[0]!.ownSharePercent).toBe(50); expect(result.pairs[1]!.ownSharePercent).toBe(50);
    expect(result.pairs[2]!.ownSharePercent).toBeCloseTo(100 / 3);
    expect(result.opportunities.every((item) => item.ownBrand !== 'ACDelco')).toBe(true);
    data.snapshot.competitorLines!.push(rival(11, { brand: 'Bosh' }));
    expect(analyzeStockInsights(data).pairs).toEqual(result.pairs);
  });
  it('returns null percentages for zero and never invents detailed legacy stock', () => {
    const zero = analyzeStockInsights(input());
    expect(zero.overall).toMatchObject({ state: 'empty', totalUnits: 0, ownSharePercent: null, rivalSharePercent: null });
    expect(zero.pairs.every((pair) => pair.ownSharePercent === null)).toBe(true);
    expect(zero.readingState).toBe('no_classifiable_data');
    const legacy = input(); delete legacy.snapshot.ownLines; delete legacy.snapshot.competitorLines;
    expect(analyzeStockInsights(legacy)).toMatchObject({ overall: { state: 'insufficient', ownUnits: null, rivalUnits: null, totalUnits: null, ownSharePercent: null },
      readingState: 'insufficient', opportunities: [], coverage: { legacy: { heliarQuantity: 900, mouraQuantity: 900, usedInTotals: false } } });
    legacy.snapshot.competitorLines = [rival(7)];
    expect(analyzeStockInsights(legacy).opportunities).toEqual([]);
  });
  it.each([
    [{ productCode: undefined, catalogVersion: undefined }, 'manual_line'],
    [{ catalogVersion: undefined }, 'missing_catalog_version'],
    [{ catalogVersion: 1 }, 'unsupported_catalog_version'],
    [{ productCode: 'absent' }, 'product_not_found'],
    [{ brand: 'América' }, 'brand_mismatch'],
  ] as const)('keeps unresolved own units in share and reports %s / %s', (extra, reason) => {
    const result = analyzeStockInsights(input([own(8, extra)]));
    expect(result.overall.ownUnits).toBe(8);
    expect(result.coverage.analytical).toMatchObject({ included: { lines: 0, units: 0 }, excluded: { lines: 1, units: 8 }, reasons: [{ reason, lines: 1, units: 8 }] });
  });
  it('resolves the exact code plus version and suggestions only from the published version', () => {
    const data = input([own(3, { catalogVersion: 1 })], [rival(4, { amperage: 62 })]);
    data.catalogs.push({ version: 1, products: [product('h60', 'Heliar', 62, 'EFB')] });
    const result = analyzeStockInsights(data);
    expect(result.pairs[0]!.cuts).toMatchObject([{ amperageAh: 62, family: 'EFB', ownUnits: 3 }, { amperageAh: 62, family: 'SLI', rivalUnits: 4 }]);
    expect(result.opportunities[0]!.models).toEqual([]);
    const renamed = structuredClone(data); renamed.snapshot.ownLines![0]!.model = 'Texto completamente diferente';
    expect(analyzeStockInsights(renamed)).toEqual(result);
  });
  it('excludes null Ah and unknown technology without parsing the model', () => {
    const data = input([own(2), own(4, { productCode: 'h60b' })]);
    data.catalogs[0]!.products = [product('h60', 'Heliar', null), product('h60b', 'Heliar', 60, 'Convencional')];
    expect(analyzeStockInsights(data).coverage.analytical.reasons).toEqual([
      { reason: 'missing_amperage', lines: 1, units: 2 }, { reason: 'unknown_technology', lines: 1, units: 4 },
    ]);
  });
});

describe('stock insights: strict normalization and opportunities', () => {
  it.each(['SLI', ' Sli/Frota ', 'EFB', 'efb/frota', 'AGM', 'agm/FROTA', ' AGM   Moto '])('classifies only prescribed technology %s', (technology) => {
    expect(stockInsightsTechnologyFamily(technology)).toBe(technology.trim().toUpperCase().slice(0, 3));
  });
  it.each(['Convencional', '', 'AGMM', 'SLI / Frota', 'SLI Premium', null])('does not infer unknown technology %s', (technology) => {
    expect(stockInsightsTechnologyFamily(technology)).toBeNull();
  });
  it('recognizes only exact aliases on Outra and never mutates the input', () => {
    const data = input([], [rival(2, { brand: 'Outra', otherBrand: ' PÍOBAT ' }), rival(3, { brand: 'Outra', otherBrand: ' ÉLETRAN ' }),
      ...['Piobat Premium', 'Distribuidora Eletran', 'Piobat/Eletran', 'Piobatt'].map((otherBrand) => rival(7, { brand: 'Outra', otherBrand })),
      rival(11, { brand: 'Tudor', otherBrand: 'Piobat' })]);
    const before = structuredClone(data);
    const result = analyzeStockInsights(data);
    expect(result.pairs[2]!.rivalUnits).toBe(5);
    expect(result.overall.rivalUnits).toBe(44);
    expect(data).toEqual(before);
  });
  it('aggregates eligible lines, preserves exact Ah and families, then creates absences and gaps', () => {
    const data = input([own(2, { brand: 'Durex', productCode: 'd60' }), own(3, { brand: 'Durex', productCode: 'd60' }), own(1)], [
      rival(2, { brand: 'Pioneiro' }), rival(3, { brand: 'Outra', otherBrand: 'Piobat' }), rival(4, { brand: 'Outra', otherBrand: 'Eletran' }),
      rival(9, { amperage: 62 }), rival(8, { technology: 'EFB' }), rival(2), rival(0, { amperage: 70 }),
    ]);
    const result = analyzeStockInsights(data);
    expect(result.opportunities.map((item) => [item.kind, item.pairId, item.amperageAh, item.family, item.gapUnits])).toEqual([
      ['absence', 'heliar-moura', 62, 'SLI', 9], ['absence', 'heliar-moura', 60, 'EFB', 8],
      ['gap', 'durex-economy', 60, 'SLI', 4], ['gap', 'heliar-moura', 60, 'SLI', 1],
    ]);
    expect(result.opportunities[0]!.models).toEqual([]);
    expect(result.opportunities[3]!.models.map((item) => item.code)).toEqual(['h60', 'h60b']);
  });
  it('suppresses equality, own majority and zero rivals; keeps no opportunity distinct from unclassifiable', () => {
    for (const quantity of [0, 1, 2]) expect(analyzeStockInsights(input([own(2)], [rival(quantity)])).readingState).toBe('no_opportunities');
    expect(analyzeStockInsights(input([own(2, { productCode: undefined })], [rival(2, { technology: 'Convencional' })])).readingState).toBe('no_classifiable_data');
  });
  it('sorts ties by Ah then stable pair/family and filters suggestions by brand/Ah/family', () => {
    const data = input([], [rival(3), rival(3, { brand: 'Zetta' }), rival(3, { brand: 'Pioneiro' }), rival(3, { amperage: 62 })]);
    data.catalogs[0]!.products.push(product('badAh', 'Heliar', 62), product('badTech', 'Heliar', 60, 'EFB'), product('ac', 'ACDelco'));
    const result = analyzeStockInsights(data);
    expect(result.opportunities.map((item) => [item.amperageAh, item.pairId])).toEqual([[60, 'america-zetta'], [60, 'durex-economy'], [60, 'heliar-moura'], [62, 'heliar-moura']]);
    expect(result.opportunities[2]!.models.map((item) => item.code)).toEqual(['h60', 'h60b']);
  });
});

describe('stock insights: invariants and invalid data', () => {
  it('is deterministic, permutation/partition invariant, bounded and monotonic over generated quantities', () => {
    for (let quantity = 0; quantity < 40; quantity++) {
      const data = input([own(quantity), own(2)], [rival(3), rival(quantity + 1)]);
      const result = analyzeStockInsights(data);
      const permuted = structuredClone(data);
      permuted.snapshot.ownLines!.reverse(); permuted.snapshot.competitorLines!.reverse();
      expect(analyzeStockInsights(permuted)).toEqual(result);
      const partitioned = structuredClone(data); partitioned.snapshot.ownLines = [own(quantity + 2)];
      const regrouped = analyzeStockInsights(partitioned);
      expect(regrouped.overall).toEqual(result.overall); expect(regrouped.pairs).toEqual(result.pairs);
      expect(regrouped.opportunities).toEqual(result.opportunities);
      expect(stockInsightsSchema.safeParse(result).success).toBe(true);
      const ownShare = result.overall.ownSharePercent!;
      expect(ownShare).toBeGreaterThanOrEqual(0); expect(ownShare).toBeLessThanOrEqual(100);
      expect(ownShare + result.overall.rivalSharePercent!).toBeCloseTo(100);
      const moreRivals = structuredClone(data); moreRivals.snapshot.competitorLines!.push(rival(1));
      expect(analyzeStockInsights(moreRivals).overall.ownSharePercent).toBeLessThanOrEqual(ownShare);
      const moreOwn = structuredClone(data); moreOwn.snapshot.ownLines!.push(own(1));
      expect(analyzeStockInsights(moreOwn).overall.ownSharePercent).toBeGreaterThanOrEqual(ownShare);
      const coverage = result.coverage;
      expect(coverage.analytical.included.units + coverage.analytical.excluded.units).toBe(coverage.general.observed.units);
      expect(coverage.analytical.included.lines + coverage.analytical.excluded.lines).toBe(coverage.general.observed.lines);
      expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    }
  });
  it('accepts safe sums and rejects negative, fractional, nonfinite, unsafe or overflowing quantities', () => {
    expect(analyzeStockInsights(input([own(Number.MAX_SAFE_INTEGER)])).overall.totalUnits).toBe(Number.MAX_SAFE_INTEGER);
    for (const quantity of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => analyzeStockInsights(input([own(quantity)]))).toThrow();
    expect(() => analyzeStockInsights(input([own(Number.MAX_SAFE_INTEGER)], [rival(1)]))).toThrow();
  });
  it('rejects duplicate product identity/version and unsupported published version', () => {
    const duplicate = input(); duplicate.catalogs[0]!.products.push(product('h60'));
    expect(() => analyzeStockInsights(duplicate)).toThrow();
    const versions = input(); versions.catalogs.push(versions.catalogs[0]!);
    expect(() => analyzeStockInsights(versions)).toThrow();
    const unpublished = input(); unpublished.publishedCatalogVersion = 42;
    expect(() => analyzeStockInsights(unpublished)).toThrow();
  });
});
