import { createHash } from "node:crypto";
import { z } from "zod";
import {
  readProductCatalogServerConfig,
  type ProductCatalogServerConfig,
} from "@cirne/config/product-catalog-sync";
import {
  productCatalogSyncBeginResultSchema,
  productCatalogSyncDatabaseStatusSchema,
  productCatalogSyncFailRequestSchema,
  productCatalogSyncPublishRequestSchema,
  productCatalogSyncResultSchema,
  productCatalogSyncStageRequestSchema,
  productCatalogSyncStageResultSchema,
  productCatalogSyncStatusSchema,
  type MeResponse,
  type ProductCatalogSyncRequest,
} from "@cirne/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RouteRequestError } from "../routes/http";
import { productCatalogRpc } from "./http";

export function productCatalogSourceKey(
  config: Pick<ProductCatalogServerConfig, "spreadsheetId">,
) {
  return createHash("sha256")
    .update(`${config.spreadsheetId}:Base produtos`)
    .digest("hex");
}
function configured(env: Record<string, string | undefined>) {
  const state = readProductCatalogServerConfig(env);
  if (!state.configured)
    throw new RouteRequestError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      "A integração da base de produtos está desativada ou precisa de configuração.",
      false,
    );
  return state.config;
}

export async function getProductCatalogSyncStatus(
  client: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
) {
  const state = readProductCatalogServerConfig(env);
  const database = state.configured
    ? productCatalogSyncDatabaseStatusSchema.parse(
        await productCatalogRpc(client, "get_product_catalog_sync_status", {
          p_source_key: productCatalogSourceKey(state.config),
        }),
      )
    : { latestRun: null, lastPublishedRun: null };
  return productCatalogSyncStatusSchema.parse({
    ...database,
    configured: state.configured,
    reason: state.reason,
    scheduleEnabled: false,
    lastSuccessAt: database.lastPublishedRun?.completedAt ?? null,
  });
}

export async function beginProductCatalogSync(
  client: SupabaseClient,
  identity: MeResponse,
  command: ProductCatalogSyncRequest,
  origin: "cli" | "web",
  env: Record<string, string | undefined> = process.env,
) {
  const config = configured(env);
  if (config.actorId !== identity.id || origin !== "cli") {
    throw new RouteRequestError(
      403,
      "FORBIDDEN",
      "Atualização não autorizada para esta identidade.",
      false,
    );
  }
  return productCatalogSyncBeginResultSchema.parse(
    await productCatalogRpc(client, "begin_product_catalog_sync", {
      p_source_key: productCatalogSourceKey(config),
      p_request_key: command.idempotencyKey,
      p_trigger: command.trigger,
    }),
  );
}

export async function stageProductCatalogSync(
  client: SupabaseClient,
  runId: string,
  command: z.infer<typeof productCatalogSyncStageRequestSchema>,
) {
  return productCatalogSyncStageResultSchema.parse(
    await productCatalogRpc(client, "stage_product_catalog_sync", {
      p_run_id: runId,
      p_lease_token: command.leaseToken,
      p_chunk_index: command.chunkIndex,
      p_chunk_hash: command.chunkHash,
      p_rows: command.rows,
    }),
  );
}
export async function publishProductCatalogSync(
  client: SupabaseClient,
  runId: string,
  command: z.infer<typeof productCatalogSyncPublishRequestSchema>,
) {
  return productCatalogSyncResultSchema.parse(
    await productCatalogRpc(client, "publish_product_catalog_sync", {
      p_run_id: runId,
      p_lease_token: command.leaseToken,
      p_content_hash: command.contentHash,
      p_expected_row_count: command.expectedRowCount,
      p_parser_version: command.parserVersion,
      p_origin: "cli",
    }),
  );
}
export async function failProductCatalogSync(
  client: SupabaseClient,
  runId: string,
  command: z.infer<typeof productCatalogSyncFailRequestSchema>,
) {
  return productCatalogSyncResultSchema.parse(
    await productCatalogRpc(client, "fail_product_catalog_sync", {
      p_run_id: runId,
      p_lease_token: command.leaseToken,
      p_error_code: command.errorCode,
    }),
  );
}
