import { z } from "zod";

export const productCatalogSheetName = "Base produtos";
export const productCatalogRange = `'${productCatalogSheetName}'!A:R`;
export const productCatalogParserVersion = 1;
export const maxProductCatalogRows = 10_000;
export const maxProductCatalogChunkRows = 500;
export const productCatalogSyncPath = "/api/v1/product-catalog-sync";
export const productCatalogSyncRunsPath = `${productCatalogSyncPath}/runs`;
export const productCatalogRunPath = (id: string) =>
  `${productCatalogSyncRunsPath}/${encodeURIComponent(id)}`;

export const productCatalogHeaders = [
  "Cód.Fábrica",
  "Cód. Cirne",
  "Categoria",
  "Descrição Cirne",
  "Item original",
  "SKU/base",
  "Fabricante/Marca",
  "Tecnologia",
  "Tec.",
  "Amperagem (Ah)",
  "CCA (A)",
  "Voltagem (V)",
  "Posição do polo positivo",
  "Peso kg",
  "Dimensões A×C×L (mm)",
  "Dimensões C×L×A (mm)",
  "Preço médio mercado (R$)",
  "Aplicações mais comuns",
] as const;

const uuid = z.uuid().transform((value) => value.toLowerCase());
export const productCatalogHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requiredText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value === value.trim() && value === value.normalize("NFC"),
    )
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (value) => value === value.trim() && value === value.normalize("NFC"),
    )
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export const productCatalogImportRowSchema = z
  .object({
    sourceRow: z
      .number()
      .int()
      .min(2)
      .max(maxProductCatalogRows + 1),
    factoryCode: requiredText(80).refine((value) => value !== "SEM TAB"),
    cirneCode: optionalText(80),
    category: optionalText(120),
    description: requiredText(240),
    originalItem: requiredText(240),
    baseSku: requiredText(120),
    brand: requiredText(120),
    technology: optionalText(120),
    technologyAbbreviation: optionalText(40),
    amperageAh: optionalText(80),
    ccaA: optionalText(80),
    voltageV: optionalText(80),
    positivePolePosition: optionalText(120),
    weightKg: optionalText(80),
    dimensionsAxCxLmm: optionalText(120),
    dimensionsCxLxAmm: optionalText(120),
    marketAveragePrice: optionalText(80),
    commonApplications: optionalText(1_000),
  })
  .strict();

// Commercial projections deliberately omit marketAveragePrice and source rows.
export const productCatalogItemSchema = productCatalogImportRowSchema
  .omit({
    sourceRow: true,
    marketAveragePrice: true,
  })
  .strict();
export type ProductCatalogImportRow = z.infer<
  typeof productCatalogImportRowSchema
>;
export type ProductCatalogItem = z.infer<typeof productCatalogItemSchema>;

export const productCatalogSyncRequestSchema = z
  .object({
    trigger: z.literal("manual"),
    idempotencyKey: uuid,
  })
  .strict();
export const productCatalogSyncResultSchema = z
  .object({
    id: uuid,
    sourceKey: productCatalogHashSchema,
    status: z.enum(["collecting", "published", "failed"]),
    trigger: z.literal("manual"),
    startedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    generationId: uuid.nullable(),
    contentHash: productCatalogHashSchema.nullable(),
    parserVersion: z.number().int().positive().nullable(),
    sourceRowCount: z.number().int().nonnegative().max(maxProductCatalogRows),
    stagedRowCount: z.number().int().nonnegative().max(maxProductCatalogRows),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
  })
  .strict();
export const productCatalogSyncBeginResultSchema = z
  .object({
    runId: uuid,
    leaseToken: uuid.nullable(),
    replayed: z.boolean(),
    result: productCatalogSyncResultSchema,
  })
  .strict();
export const productCatalogSyncStageRequestSchema = z
  .object({
    leaseToken: uuid,
    chunkIndex: z
      .number()
      .int()
      .nonnegative()
      .max(maxProductCatalogRows - 1),
    chunkHash: productCatalogHashSchema,
    rows: z
      .array(productCatalogImportRowSchema)
      .min(1)
      .max(maxProductCatalogChunkRows),
  })
  .strict();
export const productCatalogSyncStageResultSchema = z
  .object({
    stagedCount: z.number().int().nonnegative().max(maxProductCatalogRows),
    replayed: z.boolean(),
  })
  .strict();
export const productCatalogSyncPublishRequestSchema = z
  .object({
    leaseToken: uuid,
    contentHash: productCatalogHashSchema,
    expectedRowCount: z.number().int().positive().max(maxProductCatalogRows),
    parserVersion: z.literal(productCatalogParserVersion),
  })
  .strict();
export const productCatalogSyncFailRequestSchema = z
  .object({
    leaseToken: uuid,
    errorCode: z.enum([
      "SOURCE_UNAVAILABLE",
      "SOURCE_INVALID",
      "SOURCE_CHANGED",
      "SOURCE_TOO_LARGE",
      "VALIDATION_FAILED",
      "PERSISTENCE_FAILED",
      "INTERRUPTED",
    ]),
  })
  .strict();
export const productCatalogSyncDatabaseStatusSchema = z
  .object({
    latestRun: productCatalogSyncResultSchema.nullable(),
    lastPublishedRun: productCatalogSyncResultSchema.nullable(),
  })
  .strict();
export const productCatalogSyncStatusSchema =
  productCatalogSyncDatabaseStatusSchema
    .extend({
      configured: z.boolean(),
      reason: z.enum([
        "ready",
        "disabled",
        "missing_configuration",
        "invalid_configuration",
      ]),
      scheduleEnabled: z.literal(false),
      lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .strict();

export type ProductCatalogSyncRequest = z.infer<
  typeof productCatalogSyncRequestSchema
>;
export type ProductCatalogSyncResult = z.infer<
  typeof productCatalogSyncResultSchema
>;
export type ProductCatalogSyncStatus = z.infer<
  typeof productCatalogSyncStatusSchema
>;

export const productCatalogGenerationSchema = z
  .object({
    generationId: uuid,
    fetchedAt: z.iso.datetime({ offset: true }),
    publishedAt: z.iso.datetime({ offset: true }),
    rowCount: z.number().int().positive().max(maxProductCatalogRows),
    contentHash: productCatalogHashSchema,
  })
  .strict();
