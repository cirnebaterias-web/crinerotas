import { describe, expect, it } from 'vitest';
import { clientSalesResponseSchema, type ClientSalesLine, type ProductCatalogItem, type SalesProduct } from '@cirne/contracts';
import { calculateClientSales, salesCrmContext, salesMetricsFromStats, salesWindows } from './sales-crm';

const product = (sku: string): SalesProduct => ({ sku, productDescription: `Bateria ${sku}`, itemGroup: 'SLI',
  itemSubgroup: '', category: 'Leve', brand: '', line: '' });
const row = (saleDate: string, volume: number, sku = 'A'): ClientSalesLine => ({ ...product(sku), saleDate,
  invoiceNumber: 'NF-sintética', volume, kind: volume > 0 ? 'sale' : 'return', totalAmount: volume > 0 ? '10.00' : '-10.00' });
const metadata = { clientVersion: 1, generationId: '41400000-0000-4000-8000-000000000001', fetchedAt: '2026-11-03T09:15:00Z',
  publishedAt: '2026-11-03T09:15:10Z', asOfDate: '2026-11-03', observedFrom: '2023-01-01', observedThrough: '2026-11-03' };
const client = { id: '41400000-0000-4000-8000-000000000002', name: 'Cliente sintético' };
const query = { historyPage: 1, opportunityPage: 1 };
const now = new Date('2026-11-03T12:00:00Z');
const catalogItem = (source: SalesProduct): ProductCatalogItem => ({ factoryCode: source.sku, cirneCode: '',
  category: source.category, description: source.productDescription, originalItem: source.sku,
  baseSku: source.sku, brand: source.brand || 'Marca sintética', technology: '', technologyAbbreviation: '',
  amperageAh: '', ccaA: '', voltageV: '', positivePolePosition: '', weightKg: '', dimensionsAxCxLmm: '',
  dimensionsCxLxAmm: '', commonApplications: '' });
const catalog = { status: 'available' as const, generationId: '41400000-0000-4000-8000-000000000003',
  fetchedAt: '2026-11-03T09:14:00Z', publishedAt: '2026-11-03T09:14:10Z', rowCount: 3,
  contentHash: 'a'.repeat(64) };
function catalogProjection(rows: ClientSalesLine[], products: SalesProduct[], page = 1) {
  const bought = new Set(rows.filter((entry) => entry.kind === 'sale' && entry.volume > 0
    && entry.saleDate <= metadata.asOfDate).map((entry) => entry.sku));
  const opportunities = products.filter((entry) => !bought.has(entry.sku)).map(catalogItem);
  const start = (page - 1) * 25;
  return { catalog: { ...catalog, rowCount: products.length || 1 }, topMatches: products.map(catalogItem).slice(0, 10),
    opportunities: { availability: 'available' as const, page, pageSize: 25 as const,
      totalCount: opportunities.length, totalPages: Math.ceil(opportunities.length / 25),
      coverage: { catalogProductCount: products.length, salesProductCount: products.length,
        matchedSalesProductCount: products.length, missingSalesProductCount: 0 },
      products: opportunities.slice(start, start + 25) } };
}
function calculate(rows: ClientSalesLine[], products = ['A', 'B', 'C'].map(product), reference = metadata) {
  return calculateClientSales({ ...reference, client, rows }, query, now, catalogProjection(rows, products));
}

describe('client sales analytics: explicit observed windows', () => {
  it('has hand-verifiable dates, signed chart, six-month denominator and stable SKU ties', () => {
    const result = calculate([row('2026-10-01', 12), row('2026-10-01', 4, 'B'), row('2026-10-11', 6, 'B'),
      row('2026-10-21', 2, 'B'), row('2026-10-30', -4), row('2026-09-20', -3, 'C'),
      row('2026-11-04', 999, 'C'), row('2023-01-01', 5, 'OLD')]);
    expect(clientSalesResponseSchema.safeParse(result).success).toBe(true);
    expect(result.windows).toEqual({ history: { from: '2025-12-01', through: '2026-11-03', currentMonthPartial: true },
      chart: { from: '2026-05-01', through: '2026-10-31', monthCount: 6 } });
    expect(result.metrics).toEqual({ lastPurchaseDate: '2026-10-21', daysSinceLastPurchase: 13,
      periodicityDays: 10, positivePurchaseDateCount: 3, intervalCount: 2, averageMonthlyVolume: 17 / 6,
      netVolume6: 17, previousVolume3: 0, recentVolume3: 17, opportunitySegments: [],
      cycleState: 'cycle_exceeded' });
    expect(result.chart.map((point) => point.netVolume)).toEqual([0, 0, 0, 0, -3, 20]);
    expect(result.chart[4]).toMatchObject({ salesVolume: 0, returnVolume: -3, hasRecords: true });
    expect(result.chart[0]?.hasRecords).toBe(false);
    expect(result.topProducts.map(({ sku, netVolume }) => [sku, netVolume])).toEqual([['B', 12], ['A', 8]]);
    expect(result.opportunities.availability).toBe('available');
    if (result.opportunities.availability === 'available') {
      expect(result.opportunities.products.map(({ factoryCode }) => factoryCode)).toEqual(['C']);
    }
    expect(result.history.totalCount).toBe(6);
    expect(result.history.rows[0]?.saleDate).toBe('2026-10-30');
  });
  it('counts distinct purchase days, not invoices or returns, and equality does not exceed cycle', () => {
    const result = calculate([row('2026-10-14', 1), row('2026-10-14', 2), row('2026-10-24', 3), row('2026-11-01', -1)]);
    expect(result.metrics).toMatchObject({ periodicityDays: 10, daysSinceLastPurchase: 10,
      positivePurchaseDateCount: 2, cycleState: 'within_cycle' });
  });
  it('does not invent a cycle for one date or an older purchase outside the 12-month window', () => {
    expect(calculate([row('2023-01-01', 1)]).metrics).toMatchObject({ periodicityDays: null,
      positivePurchaseDateCount: 0, cycleState: 'insufficient_history', lastPurchaseDate: '2023-01-01' });
    expect(calculate([row('2026-10-01', 1), row('2026-10-01', 2)]).metrics).toMatchObject({ periodicityDays: null, intervalCount: 0 });
  });
  it('distinguishes no history, returns only, and future-only rows without fake recency zero', () => {
    expect(calculate([])).toMatchObject({ dataState: 'no_history', metrics: { daysSinceLastPurchase: null, averageMonthlyVolume: 0 } });
    const returned = calculate([row('2026-10-01', -6)]);
    expect(returned).toMatchObject({ dataState: 'available', metrics: { lastPurchaseDate: null, averageMonthlyVolume: -1, cycleState: 'no_history' } });
    expect(returned.opportunities.availability === 'available' && returned.opportunities.totalCount).toBe(3);
    expect(calculate([row('2027-01-01', 5)])).toMatchObject({ dataState: 'no_history', history: { totalCount: 0 } });
  });
  it('a full return does not erase a historical purchase from opportunity subtraction', () => {
    const result = calculate([row('2023-01-01', 5, 'A'), row('2026-10-01', -5, 'A')]);
    expect(result.opportunities.availability).toBe('available');
    if (result.opportunities.availability === 'available') {
      expect(result.opportunities.products.map(({ factoryCode }) => factoryCode)).toEqual(['B', 'C']);
    }
    expect(result.topProducts).toEqual([]);
  });
  it('ranks at most ten positive net SKUs, deterministic ties including unicode', () => {
    const rows = ['Z', 'B', 'A', 'É', '𐀀', ...Array.from({ length: 10 }, (_, i) => `X${i}`)].map((sku) => row('2026-10-01', 3, sku));
    const result = calculate([...rows, row('2026-10-02', -5, 'Z')]);
    expect(result.topProducts).toHaveLength(10);
    expect(result.topProducts.slice(0, 2).map(({ sku }) => sku)).toEqual(['A', 'B']);
    expect(result.topProducts.some(({ sku }) => sku === 'Z')).toBe(false);
  });
  it('paginates history/opportunities with stable ties and no silent out-of-range pages', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ ...row('2026-10-01', 1), invoiceNumber: `NF-${i}` }));
    const products = Array.from({ length: 30 }, (_, i) => product(`P${String(i).padStart(2, '0')}`));
    const snapshot = { ...metadata, client, rows };
    const second = calculateClientSales(snapshot, { historyPage: 2, opportunityPage: 2 }, now,
      catalogProjection(rows, products, 2));
    expect(second.history.rows.map(({ invoiceNumber }) => invoiceNumber)).toEqual(['NF-25', 'NF-26', 'NF-27', 'NF-28', 'NF-29']);
    expect(second.opportunities.availability).toBe('available');
    if (second.opportunities.availability === 'available') {
      expect(second.opportunities.products.map(({ factoryCode }) => factoryCode)).toEqual(['P25', 'P26', 'P27', 'P28', 'P29']);
    }
    expect(() => calculateClientSales(snapshot, { historyPage: 3, opportunityPage: 1 }, now,
      catalogProjection(rows, products))).toThrow('PAGE_OUT_OF_RANGE');
  });
  it.each([
    ['2026-01-01', '2025-02-01', '2025-07-01', '2025-12-31'],
    ['2024-03-01', '2023-04-01', '2023-09-01', '2024-02-29'],
    ['2025-03-01', '2024-04-01', '2024-09-01', '2025-02-28'],
  ])('calendar boundaries for %s do not become 365-day windows', (date, historyFrom, chartFrom, chartThrough) => {
    expect(salesWindows(date)).toMatchObject({ history: { from: historyFrom, through: date }, chart: { from: chartFrom, through: chartThrough } });
  });
  it('includes boundaries exactly and leaves current partial month out of the average/chart', () => {
    const result = calculate([row('2025-11-30', 1), row('2025-12-01', 1), row('2026-04-30', 5),
      row('2026-05-01', 6), row('2026-10-31', -2), row('2026-11-03', 100)]);
    expect(result.history.totalCount).toBe(5);
    expect(result.metrics.netVolume6).toBe(4);
    expect(result.metrics.daysSinceLastPurchase).toBe(0);
  });
  it('flags only observed coverage and capture age, not operational timer status', () => {
    expect(salesCrmContext(metadata, new Date('2026-11-04T09:15:00Z')).stale).toBe(false);
    expect(salesCrmContext(metadata, new Date('2026-11-04T09:15:01Z')).stale).toBe(true);
    expect(salesCrmContext({ ...metadata, observedFrom: '2026-06-01' }, now)).toMatchObject({ coverageStatus: 'observed_only', coverageLimited: true });
    expect(salesCrmContext({ ...metadata, observedThrough: '2026-10-30' }, now).coverageLimited).toBe(true);
  });
  it('derives the same cycle from sufficient SQL statistics and rejects impossible stats', () => {
    expect(salesMetricsFromStats({ lastPurchaseDate: '2026-10-21', purchaseDayCount12: 3,
      intervalTotalDays12: 20, netVolume6: 17, recentVolume3: 17, previousVolume3: 0,
      opportunitySegments: [] }, metadata.asOfDate))
      .toEqual(calculate([row('2026-10-01', 5), row('2026-10-11', 6), row('2026-10-21', 6)]).metrics);
    expect(() => salesMetricsFromStats({ lastPurchaseDate: '2026-11-04', purchaseDayCount12: 1,
      intervalTotalDays12: 0, netVolume6: 0, recentVolume3: 0, previousVolume3: 0,
      opportunitySegments: [] }, metadata.asOfDate)).toThrow();
  });
});
