import { describe, expect, it, vi } from "vitest";
import type { ProductCatalogProjectedRow } from "@cirne/domain";
import type { ProductCatalogSyncResult } from "@cirne/contracts";
import { productCatalogSyncCommand } from "./product-catalog-sync";

const id = "11111111-1111-4111-8111-111111111111";
const lease = "22222222-2222-4222-8222-222222222222";
const env = {
  GOOGLE_PRODUCT_CATALOG_ENABLED: "true",
  GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID: "synthetic_product_sheet_123",
  GOOGLE_PRODUCT_CATALOG_ACTOR_ID: id,
  GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL:
    "test@synthetic.iam.gserviceaccount.com",
  GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY: "x".repeat(100),
};
const command = { trigger: "manual" as const, idempotencyKey: id };
const result: ProductCatalogSyncResult = {
  id,
  sourceKey: "a".repeat(64),
  status: "collecting",
  trigger: "manual",
  startedAt: "2026-11-03T09:00:00Z",
  completedAt: null,
  generationId: null,
  contentHash: null,
  parserVersion: null,
  sourceRowCount: 0,
  stagedRowCount: 0,
  errorCode: null,
};
const source = (factoryCode = "H-001"): ProductCatalogProjectedRow[] => [
  {
    sourceRow: 2,
    cells: [
      factoryCode,
      "123",
      "Automotiva",
      "Bateria 60 Ah",
      factoryCode,
      "60AH",
      "Heliar",
      "Convencional",
      "CV",
      "60",
      "440",
      "12",
      "Direita",
      "14,2",
      "190×242×175",
      "242×175×190",
      "499,90",
      "Veículos leves",
    ],
  },
];

describe("orquestração da atualização do catálogo", () => {
  it("publica somente após duas leituras integrais idênticas e staging limitado", async () => {
    const paths: string[] = [];
    const transport = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith("/runs"))
        return Response.json({
          runId: id,
          leaseToken: lease,
          replayed: false,
          result,
        });
      if (path.endsWith("/stage"))
        return Response.json({ stagedCount: 1, replayed: false });
      return Response.json({
        ...result,
        status: "published",
        generationId: id,
        sourceRowCount: 1,
        stagedRowCount: 1,
      });
    });
    const readSheet = vi.fn(async () => source());
    await expect(
      productCatalogSyncCommand("http://127.0.0.1:3000", "token", command, {
        env,
        transport,
        readSheet,
      }),
    ).resolves.toMatchObject({ status: "published" });
    expect(readSheet).toHaveBeenCalledTimes(2);
    expect(paths.filter((path) => path.endsWith("/stage"))).toHaveLength(1);
    expect(paths.at(-1)).toContain("/publish");
  });
  it("registra mudança concorrente sem publicar", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          runId: id,
          leaseToken: lease,
          replayed: false,
          result,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ...result,
          status: "failed",
          errorCode: "SOURCE_CHANGED",
        }),
      );
    const readSheet = vi
      .fn()
      .mockResolvedValueOnce(source())
      .mockResolvedValueOnce(source("H-002"));
    await expect(
      productCatalogSyncCommand("http://127.0.0.1:3000", "token", command, {
        env,
        transport,
        readSheet,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(String(transport.mock.calls[1]![0])).toContain("/fail");
  });
});
