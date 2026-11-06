import {
  salesCrmPageSize,
  salesStaleHours,
  type CatalogOpportunityPage,
  type ClientSalesLine,
  type ClientSalesQuery,
  type ClientSalesResponse,
  type ProductCatalogItem,
  type SalesCrmContext,
  type SalesGeneration,
  type SalesMetrics,
  type SalesSignalStats,
} from "@cirne/contracts";

const dayMs = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / dayMs;
function monthStart(asOfDate: string, offset: number) {
  const date = new Date(`${asOfDate.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 10);
}
export function salesWindows(asOfDate: string) {
  return {
    history: {
      from: monthStart(asOfDate, -11),
      through: asOfDate,
      currentMonthPartial: true as const,
    },
    chart: {
      from: monthStart(asOfDate, -6),
      through: new Date((dayNumber(monthStart(asOfDate, 0)) - 1) * dayMs)
        .toISOString()
        .slice(0, 10),
      monthCount: 6 as const,
    },
  };
}

/** Shared by the detail's facts and the SQL batch's sufficient statistics. No UI arithmetic. */
export function salesMetricsFromStats(
  stats: Omit<SalesSignalStats, "client">,
  asOfDate: string,
): SalesMetrics {
  const count = stats.purchaseDayCount12;
  const intervals = Math.max(0, count - 1);
  const days =
    stats.lastPurchaseDate === null
      ? null
      : dayNumber(asOfDate) - dayNumber(stats.lastPurchaseDate);
  if (
    (days !== null && days < 0) ||
    (count > 0 && days === null) ||
    (intervals === 0 && stats.intervalTotalDays12 !== 0) ||
    (intervals > 0 && stats.intervalTotalDays12 < intervals)
  )
    throw new Error("INVALID_SALES_STATS");
  const period = intervals > 0 ? stats.intervalTotalDays12 / intervals : null;
  return {
    lastPurchaseDate: stats.lastPurchaseDate,
    daysSinceLastPurchase: days,
    periodicityDays: period,
    positivePurchaseDateCount: count,
    intervalCount: intervals,
    averageMonthlyVolume: stats.netVolume6 / 6,
    netVolume6: stats.netVolume6,
    cycleState:
      days === null
        ? "no_history"
        : period === null
          ? "insufficient_history"
          : days * intervals > stats.intervalTotalDays12
            ? "cycle_exceeded"
            : "within_cycle",
  };
}

export function salesCrmContext(
  metadata: Omit<SalesGeneration, "client" | "clientVersion">,
  now: Date,
): SalesCrmContext {
  const windows = salesWindows(metadata.asOfDate);
  if (!Number.isFinite(now.getTime())) throw new Error("INVALID_CLOCK");
  return {
    ...metadata,
    windows,
    coverageStatus: "observed_only" as const,
    coverageLimited:
      metadata.observedFrom > windows.chart.from ||
      metadata.observedThrough < windows.chart.through,
    stale:
      now.getTime() - Date.parse(metadata.fetchedAt) >
      salesStaleHours * 3_600_000,
    staleAfterHours: salesStaleHours,
  };
}

// Unicode codepoint order matches PostgreSQL UTF-8 C collation, independent of host locale.
function skuOrder(a: string, b: string) {
  const left = Array.from(a, (letter) => letter.codePointAt(0)!);
  const right = Array.from(b, (letter) => letter.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}
function paginate<T>(
  items: T[],
  page: number,
): {
  page: number;
  pageSize: typeof salesCrmPageSize;
  totalCount: number;
  totalPages: number;
  items: T[];
} {
  const totalPages = Math.ceil(items.length / salesCrmPageSize);
  if (!Number.isInteger(page) || page < 1 || page > Math.max(totalPages, 1))
    throw new RangeError("PAGE_OUT_OF_RANGE");
  return {
    page,
    pageSize: salesCrmPageSize,
    totalCount: items.length,
    totalPages,
    items: items.slice((page - 1) * salesCrmPageSize, page * salesCrmPageSize),
  };
}

export function clientSalesTopProducts(
  rows: readonly ClientSalesLine[],
  asOfDate: string,
) {
  const from = salesWindows(asOfDate).history.from;
  const bySku = new Map<
    string,
    { sku: string; productDescription: string; netVolume: number }
  >();
  for (const row of rows) {
    if (row.saleDate < from || row.saleDate > asOfDate) continue;
    const total = bySku.get(row.sku) ?? {
      sku: row.sku,
      productDescription: row.productDescription,
      netVolume: 0,
    };
    total.netVolume += row.volume;
    bySku.set(row.sku, total);
  }
  return [...bySku.values()]
    .filter((product) => product.netVolume > 0)
    .sort((a, b) => b.netVolume - a.netVolume || skuOrder(a.sku, b.sku))
    .slice(0, 10);
}

export type ClientCatalogProjection =
  | {
      catalog: { status: "catalog_unavailable" };
      topMatches: [];
      opportunities: null;
    }
  | {
      catalog: Extract<ClientSalesResponse["catalog"], { status: "available" }>;
      topMatches: ProductCatalogItem[];
      opportunities: CatalogOpportunityPage;
    };

export function calculateClientSales(
  snapshot: SalesGeneration & { rows: ClientSalesLine[] },
  query: ClientSalesQuery,
  now: Date,
  catalogProjection: ClientCatalogProjection = {
    catalog: { status: "catalog_unavailable" },
    topMatches: [],
    opportunities: null,
  },
): ClientSalesResponse {
  const { client, clientVersion, rows, ...metadata } = snapshot;
  const context = salesCrmContext(metadata, now);
  const eligible = rows.filter((row) => row.saleDate <= metadata.asOfDate);
  const historyRows = eligible.filter(
    (row) => row.saleDate >= context.windows.history.from,
  );
  // Stable sort retains source-row order when dates tie; facts arrive in canonical source order.
  historyRows.sort((a, b) => b.saleDate.localeCompare(a.saleDate));
  const positiveDates = [
    ...new Set(
      historyRows
        .filter((row) => row.kind === "sale" && row.volume > 0)
        .map((row) => row.saleDate),
    ),
  ].sort();
  const lastPurchaseDate = eligible.reduce<string | null>(
    (latest, row) =>
      row.kind === "sale" &&
      row.volume > 0 &&
      (latest === null || row.saleDate > latest)
        ? row.saleDate
        : latest,
    null,
  );
  const chart = Array.from({ length: 6 }, (_, index) => ({
    month: monthStart(metadata.asOfDate, index - 6).slice(0, 7),
    netVolume: 0,
    salesVolume: 0,
    returnVolume: 0,
    hasRecords: false,
  }));
  const chartByMonth = new Map(chart.map((point) => [point.month, point]));
  for (const row of eligible) {
    const point = chartByMonth.get(row.saleDate.slice(0, 7));
    if (point) {
      point.hasRecords = true;
      point.netVolume += row.volume;
      if (row.kind === "sale") point.salesVolume += row.volume;
      else point.returnVolume += row.volume;
    }
  }
  const metrics = salesMetricsFromStats(
    {
      lastPurchaseDate,
      purchaseDayCount12: positiveDates.length,
      intervalTotalDays12:
        positiveDates.length < 2
          ? 0
          : dayNumber(positiveDates.at(-1)!) - dayNumber(positiveDates[0]!),
      netVolume6: chart.reduce((total, point) => total + point.netVolume, 0),
    },
    metadata.asOfDate,
  );
  const matchByCode = new Map(
    catalogProjection.topMatches.map((product) => [
      product.factoryCode,
      product,
    ]),
  );
  const topProducts = clientSalesTopProducts(eligible, metadata.asOfDate).map(
    (product) => ({
      ...product,
      catalogMatch: matchByCode.has(product.sku)
        ? ("matched" as const)
        : ("catalog_missing" as const),
      catalogItem: matchByCode.get(product.sku) ?? null,
    }),
  );
  const history = paginate(historyRows, query.historyPage);
  const { generationId: salesGenerationId, ...publicContext } = context;
  return {
    schemaVersion: 2,
    ...publicContext,
    salesGenerationId,
    client,
    clientVersion,
    catalog: catalogProjection.catalog,
    dataState: eligible.length ? "available" : "no_history",
    metrics,
    chart,
    topProducts,
    history: {
      page: history.page,
      pageSize: history.pageSize,
      totalCount: history.totalCount,
      totalPages: history.totalPages,
      rows: history.items,
    },
    opportunities: catalogProjection.opportunities ?? {
      availability: "catalog_unavailable",
    },
  };
}
