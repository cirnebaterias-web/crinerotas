import {
  stockInsightsInputSchema, stockInsightsSchema,
  type StockInsights, type StockInsightsInput, type StockInsightsFamily,
  type StockInsightsExclusionReason, type StockInsightsPairId, type StockInsightsProduct,
} from '@cirne/contracts';

export function normalizeStockInsightsText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/gu, ' ');
}

export function stockInsightsTechnologyFamily(text: string | null): StockInsightsFamily | null {
  const normalized = normalizeStockInsightsText(text ?? '');
  if (normalized === 'sli' || normalized === 'sli/frota') return 'SLI';
  if (normalized === 'efb' || normalized === 'efb/frota') return 'EFB';
  if (normalized === 'agm' || normalized === 'agm/frota' || normalized === 'agm moto') return 'AGM';
  return null;
}

const pairs = [
  { id: 'heliar-moura', label: 'Heliar × Moura', ownBrand: 'Heliar' },
  { id: 'america-zetta', label: 'América × Zetta', ownBrand: 'América' },
  { id: 'durex-economy', label: 'Durex/Strada × Pioneiro + Piobat + Eletran', ownBrand: 'Durex' },
] as const;

function ownPair(brand: string): StockInsightsPairId | null {
  return pairs.find((pair) => pair.ownBrand === brand)?.id ?? null;
}
function rivalPair(brand: string, otherBrand?: string): StockInsightsPairId | null {
  if (brand === 'Moura') return 'heliar-moura';
  if (brand === 'Zetta') return 'america-zetta';
  if (brand === 'Pioneiro') return 'durex-economy';
  if (brand === 'Outra' && ['piobat', 'eletran'].includes(normalizeStockInsightsText(otherBrand ?? ''))) return 'durex-economy';
  return null;
}
function shares(ownUnits: number, rivalUnits: number, available = true) {
  const totalUnits = ownUnits + rivalUnits;
  return { ownUnits, rivalUnits, totalUnits,
    ownSharePercent: available && totalUnits > 0 ? ownUnits / totalUnits * 100 : null,
    rivalSharePercent: available && totalUnits > 0 ? rivalUnits / totalUnits * 100 : null };
}
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Pure local projection. Catalog identity must be supplied explicitly, never inferred. */
export function analyzeStockInsights(input: StockInsightsInput): StockInsights {
  const { snapshot, catalogs, publishedCatalogVersion } = stockInsightsInputSchema.parse(input);
  const complete = snapshot.ownLines !== undefined && snapshot.competitorLines !== undefined;
  const ownUnits = (snapshot.ownLines ?? []).reduce((sum, line) => sum + line.quantity, 0);
  const rivalUnits = (snapshot.competitorLines ?? []).reduce((sum, line) => sum + line.quantity, 0);
  const overallShares = shares(ownUnits, rivalUnits, complete);
  const resultPairs = pairs.map((pair) => ({ ...pair, ...shares(0, 0, complete), differenceUnits: 0,
    state: (complete ? 'empty' : 'insufficient') as 'available' | 'empty' | 'insufficient',
    cuts: [] as StockInsights['pairs'][number]['cuts'] }));
  const cuts = new Map<string, StockInsights['pairs'][number]['cuts'][number]>();
  const included = { lines: 0, units: 0 };
  const excluded = { lines: 0, units: 0 };
  const reasons = new Map<StockInsightsExclusionReason, { lines: number; units: number }>();
  function exclude(reason: StockInsightsExclusionReason, quantity: number) {
    excluded.lines++; excluded.units += quantity;
    const count = reasons.get(reason) ?? { lines: 0, units: 0 };
    count.lines++; count.units += quantity; reasons.set(reason, count);
  }
  function include(pairId: StockInsightsPairId, amperageAh: number, family: StockInsightsFamily, quantity: number, side: 'ownUnits' | 'rivalUnits') {
    included.lines++; included.units += quantity;
    const key = `${pairId}:${amperageAh}:${family}`;
    const cut = cuts.get(key) ?? { pairId, amperageAh, family, ...shares(0, 0), differenceUnits: 0 };
    cut[side] += quantity; cuts.set(key, cut);
  }
  for (const line of snapshot.ownLines ?? []) {
    const pairId = ownPair(line.brand);
    const pair = resultPairs.find((item) => item.id === pairId);
    if (pair) pair.ownUnits += line.quantity;
    if (!pairId) { exclude('outside_commercial_pairs', line.quantity); continue; }
    if (!line.productCode) { exclude('manual_line', line.quantity); continue; }
    if (!line.catalogVersion) { exclude('missing_catalog_version', line.quantity); continue; }
    const catalog = catalogs.find((item) => item.version === line.catalogVersion);
    if (!catalog) { exclude('unsupported_catalog_version', line.quantity); continue; }
    const product = catalog.products.find((item) => item.code === line.productCode);
    if (!product) { exclude('product_not_found', line.quantity); continue; }
    if (product.brand !== line.brand) { exclude('brand_mismatch', line.quantity); continue; }
    if (product.amperageAh === null) { exclude('missing_amperage', line.quantity); continue; }
    const family = stockInsightsTechnologyFamily(product.technology);
    if (!family) { exclude('unknown_technology', line.quantity); continue; }
    include(pairId, product.amperageAh, family, line.quantity, 'ownUnits');
  }
  for (const line of snapshot.competitorLines ?? []) {
    const pairId = rivalPair(line.brand, line.otherBrand);
    const pair = resultPairs.find((item) => item.id === pairId);
    if (pair) pair.rivalUnits += line.quantity;
    if (!pairId) { exclude('outside_commercial_pairs', line.quantity); continue; }
    const family = stockInsightsTechnologyFamily(line.technology);
    if (!family) { exclude('unknown_technology', line.quantity); continue; }
    include(pairId, line.amperage, family, line.quantity, 'rivalUnits');
  }
  for (const cut of cuts.values()) {
    Object.assign(cut, shares(cut.ownUnits, cut.rivalUnits));
    cut.differenceUnits = cut.ownUnits - cut.rivalUnits;
    resultPairs.find((pair) => pair.id === cut.pairId)!.cuts.push(cut);
  }
  for (const pair of resultPairs) {
    Object.assign(pair, shares(pair.ownUnits, pair.rivalUnits, complete));
    pair.differenceUnits = pair.ownUnits - pair.rivalUnits;
    pair.state = !complete ? 'insufficient' : pair.totalUnits ? 'available' : 'empty';
    pair.cuts.sort((a, b) => a.amperageAh - b.amperageAh || compareText(a.family, b.family));
  }
  const published = catalogs.find((catalog) => catalog.version === publishedCatalogVersion)!;
  const opportunities: StockInsights['opportunities'] = [];
  // Missing arrays cannot establish an absence, even when rival lines are available.
  if (complete) for (const pair of resultPairs) for (const cut of pair.cuts) {
    if (cut.rivalUnits <= cut.ownUnits) continue;
    const models: StockInsightsProduct[] = published.products.filter((product) =>
      product.brand === pair.ownBrand && product.amperageAh === cut.amperageAh &&
      stockInsightsTechnologyFamily(product.technology) === cut.family)
      .sort((a, b) => compareText(a.model, b.model) || compareText(a.code, b.code));
    opportunities.push({ pairId: pair.id, ownBrand: pair.ownBrand, amperageAh: cut.amperageAh,
      family: cut.family, ownUnits: cut.ownUnits, rivalUnits: cut.rivalUnits,
      gapUnits: cut.rivalUnits - cut.ownUnits, kind: cut.ownUnits === 0 ? 'absence' : 'gap', models });
  }
  opportunities.sort((a, b) => Number(a.kind !== 'absence') - Number(b.kind !== 'absence') ||
    b.gapUnits - a.gapUnits || a.amperageAh - b.amperageAh ||
    compareText(a.pairId, b.pairId) || compareText(a.family, b.family));
  return stockInsightsSchema.parse({
    schemaVersion: 1,
    overall: { ...overallShares, ownUnits: snapshot.ownLines === undefined ? null : ownUnits,
      rivalUnits: snapshot.competitorLines === undefined ? null : rivalUnits,
      totalUnits: complete ? ownUnits + rivalUnits : null,
      state: !complete ? 'insufficient' : ownUnits + rivalUnits ? 'available' : 'empty' },
    pairs: complete ? resultPairs : resultPairs.map((pair) => ({
      ...pair, state: 'insufficient', ownUnits: null, rivalUnits: null, totalUnits: null,
      differenceUnits: null, ownSharePercent: null, rivalSharePercent: null, cuts: [],
    })), opportunities,
    readingState: !complete ? 'insufficient' : included.lines === 0 ? 'no_classifiable_data' :
      opportunities.length ? 'opportunities' : 'no_opportunities',
    coverage: {
      general: { ownLinesAvailable: snapshot.ownLines !== undefined, rivalLinesAvailable: snapshot.competitorLines !== undefined,
        observed: { lines: (snapshot.ownLines?.length ?? 0) + (snapshot.competitorLines?.length ?? 0), units: ownUnits + rivalUnits } },
      analytical: { included, excluded, reasons: [...reasons].sort(([a], [b]) => compareText(a, b)).map(([reason, count]) => ({ reason, ...count })) },
      partial: !complete || excluded.lines > 0,
      legacy: { heliarQuantity: snapshot.heliarQuantity, mouraQuantity: snapshot.mouraQuantity, usedInTotals: false },
    },
    caution: 'Sinais do estoque observado, não previsão de venda, demanda, giro, pedido recomendado ou garantia de compatibilidade. O gap não é quantidade sugerida de compra ou reposição. Antes de ofertar, confirme aplicação, dimensões, polaridade e demanda do cliente.',
  });
}
