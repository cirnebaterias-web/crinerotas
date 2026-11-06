import { describe, expect, it } from "vitest";
import {
  normalizeProductCatalogRows,
  ProductCatalogSourceValidationError,
} from "./product-catalog";

const cells = [
  " H-001 ",
  " 123 ",
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

describe("normalização da base oficial de produtos", () => {
  it("aplica somente bordas e NFC e preserva a posição original", () => {
    const [row] = normalizeProductCatalogRows([{ sourceRow: 2, cells }]);
    expect(row).toMatchObject({
      sourceRow: 2,
      factoryCode: "H-001",
      cirneCode: "123",
      description: "Bateria 60 Ah",
    });
  });

  it.each([
    { rows: [{ sourceRow: 2, cells: ["", ...cells.slice(1)] }] },
    { rows: [{ sourceRow: 2, cells: ["SEM TAB", ...cells.slice(1)] }] },
    {
      rows: [
        { sourceRow: 2, cells },
        { sourceRow: 3, cells: ["H-001", ...cells.slice(1)] },
      ],
    },
  ])(
    "rejeita integralmente chave ausente, marcador ou duplicidade",
    ({ rows }) => {
      expect(() => normalizeProductCatalogRows(rows)).toThrow(
        ProductCatalogSourceValidationError,
      );
    },
  );

  it("não modifica caixa, zeros, hífens, espaços internos ou pontuação", () => {
    const variants = ["h-001", "0H-001", "H 001", "H.001"];
    const rows = variants.map((factoryCode, index) => ({
      sourceRow: index + 2,
      cells: [factoryCode, ...cells.slice(1)],
    }));
    expect(
      normalizeProductCatalogRows(rows).map((row) => row.factoryCode),
    ).toEqual(variants);
  });
});
