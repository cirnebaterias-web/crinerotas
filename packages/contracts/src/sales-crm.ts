import { z } from "zod";
import {
  productCatalogGenerationSchema,
  productCatalogItemSchema,
} from "./product-catalog";
import {
  clientSalesLineSchema,
  maxSalesRows,
  salesGenerationSchema,
  salesProductSchema,
} from "./sales";

const uuid = z.uuid().transform((value) => value.toLowerCase());
const volume = z.number().int().min(-100_000_000_000).max(100_000_000_000);
const count = z.number().int().nonnegative().max(maxSalesRows);
export const salesCrmPageSize = 25;
export const salesStaleHours = 24;
export const salesMetricsSchema = z
  .object({
    lastPurchaseDate: z.iso.date().nullable(),
    daysSinceLastPurchase: z.number().int().nonnegative().nullable(),
    periodicityDays: z.number().positive().nullable(),
    positivePurchaseDateCount: count,
    intervalCount: count,
    averageMonthlyVolume: z.number().finite(),
    netVolume6: volume,
    recentVolume3: volume.default(0),
    previousVolume3: volume.default(0),
    opportunitySegments: z
      .array(z.enum(["first_line", "second_line", "motorcycle", "heavy"]))
      .max(4)
      .default([]),
    cycleState: z.enum([
      "no_history",
      "insufficient_history",
      "within_cycle",
      "cycle_exceeded",
    ]),
  })
  .strict();
export const salesWindowsSchema = z
  .object({
    history: z
      .object({
        from: z.iso.date(),
        through: z.iso.date(),
        currentMonthPartial: z.literal(true),
      })
      .strict(),
    chart: z
      .object({
        from: z.iso.date(),
        through: z.iso.date(),
        monthCount: z.literal(6),
      })
      .strict(),
  })
  .strict();
export const salesCrmContextSchema = salesGenerationSchema
  .omit({ client: true, clientVersion: true })
  .extend({
    coverageStatus: z.literal("observed_only"),
    coverageLimited: z.boolean(),
    stale: z.boolean(),
    staleAfterHours: z.literal(salesStaleHours),
    windows: salesWindowsSchema,
  })
  .strict();
export const productCatalogAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("catalog_unavailable") }).strict(),
  productCatalogGenerationSchema
    .extend({ status: z.literal("available") })
    .strict(),
]);
export const productCatalogCoverageSchema = z
  .object({
    catalogProductCount: count,
    salesProductCount: count,
    matchedSalesProductCount: count,
    missingSalesProductCount: count,
  })
  .strict()
  .refine(
    (value) =>
      value.matchedSalesProductCount + value.missingSalesProductCount ===
      value.salesProductCount,
  );
export const clientSalesCatalogContextSchema = salesGenerationSchema
  .omit({ generationId: true })
  .extend({
    salesGenerationId: uuid,
    catalogGenerationId: uuid.nullable(),
    catalog: productCatalogAvailabilitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const inconsistent =
      value.catalog.status === "available"
        ? value.catalogGenerationId === null ||
          value.catalog.generationId !== value.catalogGenerationId
        : value.catalogGenerationId !== null;
    if (inconsistent) {
      context.addIssue({
        code: "custom",
        message: "Contexto de catálogo inconsistente.",
      });
    }
  });
const paging = {
  page: z.number().int().min(1).max(4000),
  pageSize: z.literal(salesCrmPageSize),
  totalCount: count,
  totalPages: z.number().int().nonnegative().max(4000),
};
export const catalogOpportunityPageSchema = z
  .object({
    availability: z.literal("available"),
    ...paging,
    coverage: productCatalogCoverageSchema,
    products: z.array(productCatalogItemSchema).max(salesCrmPageSize),
  })
  .strict();
export const catalogOpportunityRpcSchema = catalogOpportunityPageSchema
  .extend({
    salesGenerationId: uuid,
    catalogGenerationId: uuid,
    asOfDate: z.iso.date(),
    clientVersion: salesGenerationSchema.shape.clientVersion,
  })
  .strict();
export const productCatalogMatchesRpcSchema = z
  .object({
    salesGenerationId: uuid,
    catalogGenerationId: uuid,
    asOfDate: z.iso.date(),
    clientVersion: salesGenerationSchema.shape.clientVersion,
    products: z.array(productCatalogItemSchema).max(10),
  })
  .strict();
export const clientSalesResponseSchema = salesCrmContextSchema
  .omit({ generationId: true })
  .extend({
    schemaVersion: z.literal(2),
    salesGenerationId: uuid,
    client: salesGenerationSchema.shape.client,
    clientVersion: salesGenerationSchema.shape.clientVersion,
    catalog: productCatalogAvailabilitySchema,
    dataState: z.enum(["available", "no_history"]),
    metrics: salesMetricsSchema,
    chart: z
      .array(
        z
          .object({
            month: z.string().regex(/^\d{4}-\d{2}$/),
            netVolume: volume,
            salesVolume: volume.nonnegative(),
            returnVolume: volume.nonpositive(),
            hasRecords: z.boolean(),
          })
          .strict(),
      )
      .length(6),
    topProducts: z
      .array(
        z
          .object({
            sku: salesProductSchema.shape.sku,
            productDescription: salesProductSchema.shape.productDescription,
            netVolume: volume.positive(),
            catalogMatch: z.enum(["matched", "catalog_missing"]),
            catalogItem: productCatalogItemSchema.nullable(),
          })
          .strict(),
      )
      .max(10),
    history: z
      .object({
        ...paging,
        rows: z.array(clientSalesLineSchema).max(salesCrmPageSize),
      })
      .strict(),
    opportunities: z.discriminatedUnion("availability", [
      z.object({ availability: z.literal("catalog_unavailable") }).strict(),
      catalogOpportunityPageSchema,
    ]),
  })
  .strict();

export const clientSalesQuerySchema = z
  .object({
    salesGenerationId: uuid.optional(),
    catalogState: z.enum(["available", "catalog_unavailable"]).optional(),
    catalogGenerationId: uuid.optional(),
    asOfDate: z.iso.date().optional(),
    clientVersion: z.coerce
      .number()
      .int()
      .positive()
      .max(2147483647)
      .optional(),
    historyPage: z.coerce.number().int().min(1).max(4000).default(1),
    opportunityPage: z.coerce.number().int().min(1).max(4000).default(1),
  })
  .strict()
  .superRefine((value, context) => {
    const pinnedSales = Boolean(value.salesGenerationId);
    const pinnedCatalog = value.catalogState !== undefined;
    const availableCatalog = value.catalogState === "available";
    if (
      pinnedSales !== Boolean(value.asOfDate) ||
      pinnedSales !== Boolean(value.clientVersion) ||
      pinnedSales !== pinnedCatalog ||
      Boolean(value.catalogGenerationId) !== availableCatalog ||
      (value.historyPage > 1 && !pinnedSales) ||
      (value.opportunityPage > 1 && (!pinnedSales || !availableCatalog))
    ) {
      context.addIssue({
        code: "custom",
        message: "Fixe as gerações, a data e a versão do cliente ao paginar.",
      });
    }
  });

const readContext = {
  generationId: uuid.optional(),
  asOfDate: z.iso.date().optional(),
};
export const salesSignalsQuerySchema = z
  .object({
    ...readContext,
    sellerId: uuid,
    serviceDate: z.iso.date(),
    clientIds: z
      .array(uuid)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict()
  .refine((value) => Boolean(value.generationId) === Boolean(value.asOfDate));
export const salesSignalStatsSchema = z
  .object({
    client: salesGenerationSchema.shape.client,
    lastPurchaseDate: z.iso.date().nullable(),
    purchaseDayCount12: count,
    intervalTotalDays12: z.number().int().nonnegative().max(366),
    netVolume6: volume,
    recentVolume3: volume.default(0),
    previousVolume3: volume.default(0),
    opportunitySegments: z
      .array(z.enum(["first_line", "second_line", "motorcycle", "heavy"]))
      .max(4)
      .default([]),
  })
  .strict();
export const salesSignalBatchSchema = salesGenerationSchema
  .omit({ client: true, clientVersion: true })
  .extend({
    sellerId: uuid,
    signals: z.array(salesSignalStatsSchema).max(50),
  })
  .strict();
export const salesSignalsResponseSchema = salesCrmContextSchema
  .extend({
    schemaVersion: z.literal(1),
    sellerId: uuid,
    serviceDate: z.iso.date(),
    signals: z
      .array(
        z
          .object({
            client: salesGenerationSchema.shape.client,
            metrics: salesMetricsSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type ClientSalesResponse = z.infer<typeof clientSalesResponseSchema>;
export type SalesCrmContext = z.infer<typeof salesCrmContextSchema>;
export type ClientSalesQuery = z.infer<typeof clientSalesQuerySchema>;
export type SalesMetrics = z.infer<typeof salesMetricsSchema>;
export type SalesSignalStats = z.infer<typeof salesSignalStatsSchema>;
export type SalesSignalsQuery = z.infer<typeof salesSignalsQuerySchema>;
export type SalesSignalsResponse = z.infer<typeof salesSignalsResponseSchema>;
export type CatalogOpportunityPage = z.infer<
  typeof catalogOpportunityPageSchema
>;
