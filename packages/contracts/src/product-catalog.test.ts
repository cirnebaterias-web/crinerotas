import { describe, expect, it } from "vitest";
import {
  productCatalogHeaders,
  productCatalogImportRowSchema,
  productCatalogItemSchema,
} from "./product-catalog";

const row = {
  sourceRow: 2,
  factoryCode: "H-001",
  cirneCode: "123",
  category: "Automotiva",
  description: "Bateria 60 Ah",
  originalItem: "H-001",
  baseSku: "60AH",
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
  marketAveragePrice: "499,90",
  commonApplications: "Veículos leves",
};

describe("contrato da base oficial de produtos", () => {
  it("fixa os 18 cabeçalhos exatos da aba autorizada", () => {
    expect(productCatalogHeaders).toHaveLength(18);
    expect(productCatalogHeaders[0]).toBe("Cód.Fábrica");
    expect(productCatalogHeaders.at(-1)).toBe("Aplicações mais comuns");
  });

  it("preserva a evidência privada e omite preço/linha da projeção comercial", () => {
    expect(productCatalogImportRowSchema.parse(row)).toEqual(row);
    const commercial = Object.fromEntries(
      Object.entries(row).filter(
        ([key]) => key !== "sourceRow" && key !== "marketAveragePrice",
      ),
    );
    expect(productCatalogItemSchema.parse(commercial)).toEqual(commercial);
    expect(productCatalogItemSchema.safeParse(row).success).toBe(false);
  });

  it.each(["", "SEM TAB", " H-001", "H-001 "])(
    "rejeita código de fábrica inválido: %j",
    (factoryCode) => {
      expect(
        productCatalogImportRowSchema.safeParse({ ...row, factoryCode })
          .success,
      ).toBe(false);
    },
  );
});
