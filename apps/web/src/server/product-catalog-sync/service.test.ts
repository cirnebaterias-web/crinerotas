import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse, ProductCatalogSyncResult } from "@cirne/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { productCatalogRpc } from "./http";
import {
  beginProductCatalogSync,
  getProductCatalogSyncStatus,
  productCatalogSourceKey,
} from "./service";
vi.mock("./http", () => ({ productCatalogRpc: vi.fn() }));
const rpc = vi.mocked(productCatalogRpc);
const client = {} as SupabaseClient;
const id = "11111111-1111-4111-8111-111111111111";
const identity: MeResponse = {
  id,
  displayName: "Técnico sintético",
  status: "active",
  roles: ["manager"],
  capabilities: ["products.sync"],
  scopeIds: [],
};
const env = {
  GOOGLE_PRODUCT_CATALOG_ENABLED: "true",
  GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID: "synthetic_product_sheet_123",
  GOOGLE_PRODUCT_CATALOG_ACTOR_ID: id,
};
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
beforeEach(() => rpc.mockReset());
describe("serviço BFF do catálogo", () => {
  it("nasce desabilitado, sem agenda e sem consultar banco", async () => {
    await expect(
      getProductCatalogSyncStatus(client, {}),
    ).resolves.toMatchObject({
      configured: false,
      scheduleEnabled: false,
      latestRun: null,
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("mantém a fonte privada e exige ator técnico pela CLI", async () => {
    rpc.mockResolvedValue({
      runId: id,
      leaseToken: id,
      replayed: false,
      result,
    });
    const command = { trigger: "manual" as const, idempotencyKey: id };
    await expect(
      beginProductCatalogSync(client, identity, command, "web", env),
    ).rejects.toMatchObject({ status: 403 });
    await beginProductCatalogSync(client, identity, command, "cli", env);
    expect(rpc).toHaveBeenLastCalledWith(client, "begin_product_catalog_sync", {
      p_source_key: productCatalogSourceKey({
        spreadsheetId: env.GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID,
      }),
      p_request_key: id,
      p_trigger: "manual",
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(
      env.GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID,
    );
  });
});
