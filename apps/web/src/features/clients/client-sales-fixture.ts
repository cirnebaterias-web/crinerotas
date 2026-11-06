import type { ClientSalesResponse, ProductCatalogItem } from "@cirne/contracts";

const catalogItem = (
  factoryCode: string,
  description: string,
): ProductCatalogItem => ({
  factoryCode,
  cirneCode: "",
  category: "Automotiva",
  description,
  originalItem: factoryCode,
  baseSku: factoryCode,
  brand: "Heliar",
  technology: "Convencional",
  technologyAbbreviation: "CV",
  amperageAh: "60",
  ccaA: "440",
  voltageV: "12",
  positivePolePosition: "Direita",
  weightKg: "14,2",
  dimensionsAxCxLmm: "190×242×175",
  dimensionsCxLxAmm: "242×175×190",
  commonApplications: "Veículos leves",
});

// Synthetic values used exclusively by component and browser tests.
export function syntheticClientSales(
  clientId = "40000000-0000-4000-8000-000000000001",
): ClientSalesResponse {
  const topCatalog = catalogItem(
    "SKU-01",
    "Bateria oficial de descrição extensa para testar quebra de linha no celular",
  );
  return {
    schemaVersion: 2,
    salesGenerationId: "70000000-0000-4000-8000-000000000001",
    clientVersion: 1,
    fetchedAt: "2026-11-03T09:15:00Z",
    publishedAt: "2026-11-03T09:16:00Z",
    observedFrom: "2026-01-01",
    observedThrough: "2026-11-02",
    asOfDate: "2026-11-03",
    client: { id: clientId, name: "Loja Centro" },
    dataState: "available",
    coverageStatus: "observed_only",
    coverageLimited: true,
    stale: false,
    staleAfterHours: 24,
    catalog: {
      status: "available",
      generationId: "70000000-0000-4000-8000-000000000002",
      fetchedAt: "2026-11-03T09:00:00Z",
      publishedAt: "2026-11-03T09:01:00Z",
      rowCount: 157,
      contentHash: "a".repeat(64),
    },
    windows: {
      history: {
        from: "2025-12-01",
        through: "2026-11-03",
        currentMonthPartial: true,
      },
      chart: { from: "2026-05-01", through: "2026-10-31", monthCount: 6 },
    },
    metrics: {
      lastPurchaseDate: "2026-10-01",
      daysSinceLastPurchase: 33,
      periodicityDays: 20,
      positivePurchaseDateCount: 3,
      intervalCount: 2,
      averageMonthlyVolume: 3,
      netVolume6: 18,
      cycleState: "cycle_exceeded",
    },
    chart: [0, 10, -5, 0, 8, 5].map((netVolume, index) => ({
      month: `2026-${String(index + 5).padStart(2, "0")}`,
      netVolume,
      salesVolume: Math.max(netVolume, 0),
      returnVolume: Math.min(netVolume, 0),
      hasRecords: netVolume !== 0,
    })),
    topProducts: [
      {
        sku: "SKU-01",
        productDescription: "Descrição de Vendas",
        netVolume: 18,
        catalogMatch: "matched",
        catalogItem: topCatalog,
      },
    ],
    history: {
      page: 1,
      pageSize: 25,
      totalCount: 26,
      totalPages: 2,
      rows: [
        {
          sku: "SKU-01",
          productDescription: "Bateria sintética",
          itemGroup: "Bateria",
          itemSubgroup: "",
          category: "",
          brand: "",
          line: "",
          invoiceNumber: "0001",
          saleDate: "2026-07-01",
          kind: "return",
          volume: -5,
          totalAmount: "-100.00",
        },
      ],
    },
    opportunities: {
      availability: "available",
      page: 1,
      pageSize: 25,
      totalCount: 1,
      totalPages: 1,
      coverage: {
        catalogProductCount: 157,
        salesProductCount: 135,
        matchedSalesProductCount: 135,
        missingSalesProductCount: 0,
      },
      products: [
        catalogItem("SKU-02", "Produto exclusivo do catálogo oficial"),
      ],
    },
  };
}
