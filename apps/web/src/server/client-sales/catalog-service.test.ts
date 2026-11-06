import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { productCatalogRpc } from "../product-catalog-sync/http";
import {
  readClientCatalogMatches,
  readClientCatalogOpportunities,
  readClientSalesCatalogContext,
} from "./service";
vi.mock("../product-catalog-sync/http", () => ({ productCatalogRpc: vi.fn() }));
const rpc = vi.mocked(productCatalogRpc);
const db = {} as SupabaseClient;
const clientId = "41400000-0000-4000-8000-000000000001";
const salesId = "41400000-0000-4000-8000-000000000002";
const catalogId = "41400000-0000-4000-8000-000000000003";
const context = {
  salesGenerationId: salesId,
  catalogGenerationId: catalogId,
  asOfDate: "2026-11-03",
  clientVersion: 1,
};
const item = {
  factoryCode: "H-001",
  cirneCode: "",
  category: "Automotiva",
  description: "Bateria 60 Ah",
  originalItem: "H-001",
  baseSku: "60AH",
  brand: "Heliar",
  technology: "",
  technologyAbbreviation: "",
  amperageAh: "60",
  ccaA: "440",
  voltageV: "12",
  positivePolePosition: "Direita",
  weightKg: "",
  dimensionsAxCxLmm: "",
  dimensionsCxLxAmm: "",
  commonApplications: "",
};
beforeEach(() => rpc.mockReset());
describe("projeções privadas de catálogo no CRM", () => {
  it("fixa as duas gerações e preserva catálogo indisponível como estado explícito", async () => {
    rpc.mockResolvedValue({
      salesGenerationId: salesId,
      catalogGenerationId: null,
      fetchedAt: "2026-11-03T09:15:00Z",
      publishedAt: "2026-11-03T09:16:00Z",
      observedFrom: "2023-01-01",
      observedThrough: "2026-11-03",
      asOfDate: context.asOfDate,
      clientVersion: 1,
      client: { id: clientId, name: "Cliente sintético" },
      catalog: { status: "catalog_unavailable" },
    });
    await expect(
      readClientSalesCatalogContext(db, clientId, {
        historyPage: 1,
        opportunityPage: 1,
      }),
    ).resolves.toMatchObject({ catalog: { status: "catalog_unavailable" } });
    await readClientSalesCatalogContext(db, clientId, {
      historyPage: 2,
      opportunityPage: 1,
      salesGenerationId: salesId,
      catalogState: "catalog_unavailable",
      asOfDate: context.asOfDate,
      clientVersion: 1,
    });
    expect(rpc.mock.calls.map((call) => call[2])).toEqual([
      {
        p_client_id: clientId,
        p_sales_snapshot_id: null,
        p_catalog_snapshot_id: null,
        p_catalog_state: null,
        p_as_of_date: null,
        p_client_version: null,
      },
      {
        p_client_id: clientId,
        p_sales_snapshot_id: salesId,
        p_catalog_snapshot_id: null,
        p_catalog_state: "catalog_unavailable",
        p_as_of_date: context.asOfDate,
        p_client_version: 1,
      },
    ]);
  });
  it("aceita somente matches solicitados e uma página estritamente sem preço", async () => {
    rpc
      .mockResolvedValueOnce({ ...context, products: [item] })
      .mockResolvedValueOnce({
        ...context,
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
        products: [item],
      });
    await expect(
      readClientCatalogMatches(db, clientId, context, ["H-001"]),
    ).resolves.toEqual([item]);
    const page = await readClientCatalogOpportunities(db, clientId, context, 1);
    expect(page.products).toEqual([item]);
    expect(JSON.stringify(page)).not.toContain("marketAveragePrice");
  });
  it("fails closed if SQL tries to expose price or an unrequested item", async () => {
    rpc.mockResolvedValue({
      ...context,
      products: [{ ...item, marketAveragePrice: "499,90" }],
    });
    await expect(
      readClientCatalogMatches(db, clientId, context, ["H-001"]),
    ).rejects.toMatchObject({ status: 503 });
    rpc.mockResolvedValue({
      ...context,
      products: [{ ...item, factoryCode: "H-002" }],
    });
    await expect(
      readClientCatalogMatches(db, clientId, context, ["H-001"]),
    ).rejects.toMatchObject({ status: 503 });
  });
});
