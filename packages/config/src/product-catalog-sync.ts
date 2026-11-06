import { z } from "zod";

const serverSchema = z.object({
  GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{20,160}$/),
  GOOGLE_PRODUCT_CATALOG_ACTOR_ID: z
    .uuid()
    .transform((value) => value.toLowerCase()),
});
const sheetSchema = serverSchema.extend({
  GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL: z
    .email()
    .endsWith(".iam.gserviceaccount.com"),
  GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY: z.string().min(100).max(16_000),
});

export type ProductCatalogServerConfig = {
  spreadsheetId: string;
  actorId: string;
};
export type ProductCatalogSheetConfig = ProductCatalogServerConfig & {
  email: string;
  privateKey: string;
};
export type ProductCatalogConfigState<T = ProductCatalogSheetConfig> =
  | { configured: true; reason: "ready"; config: T }
  | {
      configured: false;
      reason: "disabled" | "missing_configuration" | "invalid_configuration";
    };

export function readProductCatalogServerConfig(
  env: Record<string, string | undefined>,
): ProductCatalogConfigState<ProductCatalogServerConfig> {
  if (
    env.GOOGLE_PRODUCT_CATALOG_ENABLED === undefined ||
    env.GOOGLE_PRODUCT_CATALOG_ENABLED === "false"
  ) {
    return { configured: false, reason: "disabled" };
  }
  if (env.GOOGLE_PRODUCT_CATALOG_ENABLED !== "true")
    return { configured: false, reason: "invalid_configuration" };
  if (
    !env.GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID?.trim() ||
    !env.GOOGLE_PRODUCT_CATALOG_ACTOR_ID?.trim()
  ) {
    return { configured: false, reason: "missing_configuration" };
  }
  const parsed = serverSchema.safeParse(env);
  if (!parsed.success)
    return { configured: false, reason: "invalid_configuration" };
  return {
    configured: true,
    reason: "ready",
    config: {
      spreadsheetId: parsed.data.GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID,
      actorId: parsed.data.GOOGLE_PRODUCT_CATALOG_ACTOR_ID,
    },
  };
}

export function readProductCatalogSheetConfig(
  env: Record<string, string | undefined>,
): ProductCatalogConfigState {
  const server = readProductCatalogServerConfig(env);
  if (!server.configured) return server;
  if (
    !env.GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL?.trim() ||
    !env.GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY?.trim()
  ) {
    return { configured: false, reason: "missing_configuration" };
  }
  const parsed = sheetSchema.safeParse(env);
  if (!parsed.success)
    return { configured: false, reason: "invalid_configuration" };
  return {
    configured: true,
    reason: "ready",
    config: {
      ...server.config,
      email: parsed.data.GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL,
      privateKey: parsed.data.GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY.replace(
        /\\n/g,
        "\n",
      ),
    },
  };
}
