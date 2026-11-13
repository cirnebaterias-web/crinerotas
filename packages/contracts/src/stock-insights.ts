import { z } from 'zod';
import { stockInputSchema } from './index';

const units = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const family = z.enum(['SLI', 'EFB', 'AGM']);
const ownBrand = z.enum(['Heliar', 'América', 'Durex', 'ACDelco']);
export const stockInsightsPairIdSchema = z.enum(['heliar-moura', 'america-zetta', 'durex-economy']);
export const stockInsightsProductSchema = z.object({
  code: z.string().trim().min(1), brand: ownBrand, model: z.string().trim().min(1),
  amperageAh: z.number().positive().finite().nullable(), technology: z.string().nullable(),
}).passthrough();
export const stockInsightsCatalogSchema = z.object({
  version: z.number().int().positive(), products: z.array(stockInsightsProductSchema),
}).passthrough().superRefine((catalog, context) => {
  const codes = new Set<string>();
  catalog.products.forEach((product, index) => {
    if (codes.has(product.code)) context.addIssue({ code: 'custom', path: ['products', index, 'code'], message: 'Código duplicado na versão.' });
    codes.add(product.code);
  });
});

export const stockInsightsInputSchema = z.object({
  snapshot: z.lazy(() => stockInputSchema),
  publishedCatalogVersion: z.number().int().positive(),
  catalogs: z.array(stockInsightsCatalogSchema),
}).strict().superRefine((input, context) => {
  const versions = input.catalogs.map((catalog) => catalog.version);
  if (new Set(versions).size !== versions.length) context.addIssue({ code: 'custom', path: ['catalogs'], message: 'Versão duplicada.' });
  if (!versions.includes(input.publishedCatalogVersion)) context.addIssue({ code: 'custom', path: ['publishedCatalogVersion'], message: 'Catálogo publicado indisponível.' });
  const quantities = [input.snapshot.heliarQuantity, input.snapshot.mouraQuantity,
    ...(input.snapshot.ownLines ?? []).map((line) => line.quantity),
    ...(input.snapshot.competitorLines ?? []).map((line) => line.quantity)];
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity))) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'Quantidade fora do limite inteiro seguro.' });
  }
  const observed = [...(input.snapshot.ownLines ?? []), ...(input.snapshot.competitorLines ?? [])];
  let total = 0;
  for (const line of observed) {
    if (line.quantity > Number.MAX_SAFE_INTEGER - total) {
      context.addIssue({ code: 'custom', path: ['snapshot'], message: 'Soma de unidades excede o limite inteiro seguro.' });
      break;
    }
    total += line.quantity;
  }
});
export type StockInsightsInput = z.infer<typeof stockInsightsInputSchema>;
export type StockInsightsCatalog = z.infer<typeof stockInsightsCatalogSchema>;
export type StockInsightsProduct = z.infer<typeof stockInsightsProductSchema>;
export type StockInsightsPairId = z.infer<typeof stockInsightsPairIdSchema>;
export type StockInsightsFamily = z.infer<typeof family>;

const shares = {
  ownUnits: units, rivalUnits: units, totalUnits: units,
  ownSharePercent: z.number().min(0).max(100).nullable(),
  rivalSharePercent: z.number().min(0).max(100).nullable(),
};
const cut = z.object({
  pairId: stockInsightsPairIdSchema, amperageAh: z.number().positive().finite(), family,
  ...shares, differenceUnits: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const stockInsightsExclusionReasonSchema = z.enum([
  'manual_line', 'missing_catalog_version', 'unsupported_catalog_version', 'product_not_found',
  'brand_mismatch', 'missing_amperage', 'unknown_technology', 'outside_commercial_pairs',
]);
export type StockInsightsExclusionReason = z.infer<typeof stockInsightsExclusionReasonSchema>;
const count = z.object({ lines: units, units }).strict();
const pairIdentity = { id: stockInsightsPairIdSchema, label: z.string(), ownBrand };
const pair = z.discriminatedUnion('state', [
  z.object({
    ...pairIdentity, ...shares,
    differenceUnits: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['available', 'empty']), cuts: z.array(cut),
  }).strict(),
  z.object({
    ...pairIdentity, state: z.literal('insufficient'),
    ownUnits: z.null(), rivalUnits: z.null(), totalUnits: z.null(), differenceUnits: z.null(),
    ownSharePercent: z.null(), rivalSharePercent: z.null(), cuts: z.array(cut).max(0),
  }).strict(),
]);
export const stockInsightsSchema = z.object({
  schemaVersion: z.literal(1),
  overall: z.object({
    state: z.enum(['available', 'empty', 'insufficient']),
    ownUnits: units.nullable(), rivalUnits: units.nullable(), totalUnits: units.nullable(),
    ownSharePercent: z.number().min(0).max(100).nullable(), rivalSharePercent: z.number().min(0).max(100).nullable(),
  }).strict(),
  pairs: z.array(pair).length(3),
  opportunities: z.array(z.object({
    pairId: stockInsightsPairIdSchema, ownBrand, amperageAh: z.number().positive().finite(), family,
    kind: z.enum(['absence', 'gap']), ownUnits: units, rivalUnits: units, gapUnits: units,
    models: z.array(stockInsightsProductSchema),
  }).strict()),
  readingState: z.enum(['opportunities', 'no_opportunities', 'no_classifiable_data', 'insufficient']),
  coverage: z.object({
    general: z.object({ ownLinesAvailable: z.boolean(), rivalLinesAvailable: z.boolean(), observed: count }).strict(),
    analytical: z.object({ included: count, excluded: count,
      reasons: z.array(z.object({ reason: stockInsightsExclusionReasonSchema, ...count.shape }).strict()),
    }).strict(),
    partial: z.boolean(),
    legacy: z.object({ heliarQuantity: units, mouraQuantity: units, usedInTotals: z.literal(false) }).strict(),
  }).strict(),
  caution: z.string(),
}).strict().superRefine((analysis, context) => {
  const complete = analysis.coverage.general.ownLinesAvailable && analysis.coverage.general.rivalLinesAvailable;
  if (analysis.pairs.some((pair) => (pair.state !== 'insufficient') !== complete)) {
    context.addIssue({ code: 'custom', path: ['pairs'], message: 'Comparações exigem os dois arrays de linhas.' });
  }
  if (!complete && analysis.opportunities.length > 0) {
    context.addIssue({ code: 'custom', path: ['opportunities'], message: 'Estoque incompleto não permite oportunidades.' });
  }
});
export type StockInsights = z.infer<typeof stockInsightsSchema>;
