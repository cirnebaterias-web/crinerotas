import type { ProductCatalogImportRow } from "@cirne/contracts";
import {
  maxProductCatalogRows,
  productCatalogHeaders,
  productCatalogImportRowSchema,
} from "@cirne/contracts";

export type ProductCatalogProjectedRow = {
  sourceRow: number;
  cells: readonly unknown[];
};

export class ProductCatalogSourceValidationError extends Error {
  constructor(
    public readonly code:
      "SOURCE_INVALID" | "SOURCE_TOO_LARGE" | "VALIDATION_FAILED",
  ) {
    super("A captura da base de produtos não passou pela validação integral.");
  }
}

function normalizedText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new ProductCatalogSourceValidationError("VALIDATION_FAILED");
  }
  return String(value).trim().normalize("NFC");
}

export function normalizeProductCatalogRows(
  projected: readonly ProductCatalogProjectedRow[],
): ProductCatalogImportRow[] {
  if (!projected.length)
    throw new ProductCatalogSourceValidationError("SOURCE_INVALID");
  if (projected.length > maxProductCatalogRows)
    throw new ProductCatalogSourceValidationError("SOURCE_TOO_LARGE");
  const seen = new Set<string>();
  const rows = projected.map(({ sourceRow, cells }) => {
    if (
      !Number.isInteger(sourceRow) ||
      sourceRow < 2 ||
      sourceRow > maxProductCatalogRows + 1 ||
      cells.length > productCatalogHeaders.length
    ) {
      throw new ProductCatalogSourceValidationError("VALIDATION_FAILED");
    }
    const values = Array.from(
      { length: productCatalogHeaders.length },
      (_, index) => normalizedText(cells[index]),
    );
    const row = productCatalogImportRowSchema.safeParse({
      sourceRow,
      factoryCode: values[0],
      cirneCode: values[1],
      category: values[2],
      description: values[3],
      originalItem: values[4],
      baseSku: values[5],
      brand: values[6],
      technology: values[7],
      technologyAbbreviation: values[8],
      amperageAh: values[9],
      ccaA: values[10],
      voltageV: values[11],
      positivePolePosition: values[12],
      weightKg: values[13],
      dimensionsAxCxLmm: values[14],
      dimensionsCxLxAmm: values[15],
      marketAveragePrice: values[16],
      commonApplications: values[17],
    });
    if (!row.success || seen.has(values[0]!))
      throw new ProductCatalogSourceValidationError("VALIDATION_FAILED");
    seen.add(values[0]!);
    return row.data;
  });
  return rows;
}

export function productCatalogRowTuple(
  row: ProductCatalogImportRow,
): readonly unknown[] {
  return [
    row.sourceRow,
    row.factoryCode,
    row.cirneCode,
    row.category,
    row.description,
    row.originalItem,
    row.baseSku,
    row.brand,
    row.technology,
    row.technologyAbbreviation,
    row.amperageAh,
    row.ccaA,
    row.voltageV,
    row.positivePolePosition,
    row.weightKg,
    row.dimensionsAxCxLmm,
    row.dimensionsCxLxAmm,
    row.marketAveragePrice,
    row.commonApplications,
  ];
}
