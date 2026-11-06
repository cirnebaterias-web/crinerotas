import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { productCatalogHeaders } from "@cirne/contracts";
import {
  createGoogleProductCatalogReader,
  projectProductCatalogGoogleResponse,
} from "./product-catalog-google";

const product = [
  "H-001",
  "123",
  "Automotiva",
  "Bateria 60 Ah",
  "H-001",
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
];
const googleBody = (rows: unknown[][] = [product]) => ({
  range: `'Base produtos'!A1:R${rows.length + 1}`,
  majorDimension: "ROWS",
  values: [[...productCatalogHeaders], ...rows],
});

describe("projeção Google da base de produtos", () => {
  it("lê somente A:R, preserva posição e ignora linha totalmente vazia", () => {
    const rows = projectProductCatalogGoogleResponse(
      googleBody([product, [], ["H-002", ...product.slice(1)]]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]?.sourceRow).toBe(4);
    expect(rows[1]?.cells[0]).toBe("H-002");
  });
  it("rejeita aba/range, cabeçalho ou largura divergentes", () => {
    const wrongRange = googleBody();
    wrongRange.range = "Produtos!A1:R2";
    const wrongHeader = googleBody();
    wrongHeader.values[0]![0] = "Código";
    const tooWide = googleBody([[...product, "extra"]]);
    for (const body of [wrongRange, wrongHeader, tooWide, { values: [] }]) {
      expect(() => projectProductCatalogGoogleResponse(body)).toThrow();
    }
  });
});

const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const config = {
  spreadsheetId: "synthetic_product_sheet_123",
  actorId: "11111111-1111-4111-8111-111111111111",
  email: "test@synthetic.iam.gserviceaccount.com",
  privateKey: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
describe("aquisição privada do catálogo", () => {
  it("assina RS256 read-only e requisita exclusivamente Base produtos A:R", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "synthetic", token_type: "Bearer" }),
      )
      .mockResolvedValueOnce(Response.json(googleBody()));
    const reader = await createGoogleProductCatalogReader(config, {
      transport,
      clock: () => new Date("2026-11-03T09:00:00Z"),
    });
    await reader();
    const assertion = (
      transport.mock.calls[0]![1]!.body as URLSearchParams
    ).get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(payload!, "base64url").toString()).scope,
    ).toBe("https://www.googleapis.com/auth/spreadsheets.readonly");
    const url = new URL(String(transport.mock.calls[1]![0]));
    expect(decodeURIComponent(url.pathname)).toContain(
      "/values/'Base produtos'!A:R",
    );
    expect(url.href).not.toContain("TAB%20PRE");
    expect(url.href).not.toContain("/Produtos");
    expect(url.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
  });
});
