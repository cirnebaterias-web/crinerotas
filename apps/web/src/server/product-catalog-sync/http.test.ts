import { describe, expect, it } from "vitest";
import type { MeResponse } from "@cirne/contracts";
import {
  readProductCatalogSyncJson,
  requireProductCatalogSyncCapability,
} from "./http";

const identity = (capabilities: string[]) => ({ capabilities }) as MeResponse;
describe("fronteira HTTP do catálogo", () => {
  it("não herda autoridade de clientes ou vendas", () => {
    expect(() =>
      requireProductCatalogSyncCapability(
        identity(["clients.import", "sales.sync"]),
      ),
    ).toThrow();
    expect(() =>
      requireProductCatalogSyncCapability(identity(["products.sync"])),
    ).not.toThrow();
  });
  it("aceita JSON limitado e rejeita mídia ou corpo acima de 1 MiB", async () => {
    const request = (body: string, headers: Record<string, string> = {}) =>
      new Request("http://localhost", {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...headers },
      });
    await expect(
      readProductCatalogSyncJson(request('{"ok":true}')),
    ).resolves.toEqual({ ok: true });
    await expect(
      readProductCatalogSyncJson(
        request("{}", { "content-length": "1048577" }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readProductCatalogSyncJson(
        new Request("http://localhost", { method: "POST", body: "{}" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
