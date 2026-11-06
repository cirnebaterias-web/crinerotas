import { createHash } from "node:crypto";
import { z } from "zod";
import { readProductCatalogSheetConfig } from "@cirne/config/product-catalog-sync";
import {
  productCatalogParserVersion,
  productCatalogRunPath,
  productCatalogSyncBeginResultSchema,
  productCatalogSyncPath,
  productCatalogSyncResultSchema,
  productCatalogSyncRunsPath,
  productCatalogSyncStageRequestSchema,
  productCatalogSyncStageResultSchema,
  productCatalogSyncStatusSchema,
  type ProductCatalogImportRow,
  type ProductCatalogSyncRequest,
} from "@cirne/contracts";
import {
  normalizeProductCatalogRows,
  productCatalogRowTuple,
  ProductCatalogSourceValidationError,
  type ProductCatalogProjectedRow,
} from "@cirne/domain";
import { safeSyncOrigin, loginSheetSyncOperator } from "./client-sheet-sync";
import {
  createGoogleProductCatalogReader,
  ProductCatalogAcquisitionError,
} from "./product-catalog-google";

export class ProductCatalogSyncCommandError extends Error {
  constructor(
    public readonly code:
      "PERSISTENCE_FAILED" | "VALIDATION_FAILED" = "PERSISTENCE_FAILED",
  ) {
    super(
      "Não foi possível concluir a atualização da base de produtos. Consulte o estado e repita a mesma intenção.",
    );
  }
}
type Options = {
  transport?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
  env?: Record<string, string | undefined>;
  readSheet?: () => Promise<ProductCatalogProjectedRow[]>;
};

async function request<T>(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  options: Options,
): Promise<T> {
  const payload = body === null ? undefined : JSON.stringify(body);
  if (payload && Buffer.byteLength(payload, "utf8") > 1_024 * 1_024)
    throw new ProductCatalogSyncCommandError("VALIDATION_FAILED");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await (options.transport ?? fetch)(
        new URL(path, safeSyncOrigin(baseUrl)),
        {
          method: payload ? "POST" : "GET",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(40_000),
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload ? { "content-type": "application/json" } : {}),
          },
          body: payload,
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (
          ![408, 429, 502, 503, 504].includes(response.status) ||
          attempt === 2
        )
          throw new ProductCatalogSyncCommandError();
      } else {
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > 64 * 1_024)
          throw new ProductCatalogSyncCommandError();
        return schema.parse(JSON.parse(text) as unknown);
      }
    } catch (error) {
      if (
        error instanceof ProductCatalogSyncCommandError ||
        error instanceof z.ZodError ||
        attempt === 2
      ) {
        throw new ProductCatalogSyncCommandError(
          error instanceof ProductCatalogSyncCommandError
            ? error.code
            : undefined,
        );
      }
    }
    await (
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(1_000 * 2 ** attempt);
  }
  throw new ProductCatalogSyncCommandError();
}

export function productCatalogContentHash(
  rows: readonly ProductCatalogImportRow[],
) {
  const hash = createHash("sha256");
  for (const row of rows)
    hash.update(
      createHash("sha256")
        .update(JSON.stringify(productCatalogRowTuple(row)), "utf8")
        .digest("hex"),
    );
  return hash.digest("hex");
}

export function productCatalogStageChunks(
  rows: readonly ProductCatalogImportRow[],
  leaseToken: string,
) {
  const chunks: z.infer<typeof productCatalogSyncStageRequestSchema>[] = [];
  for (let index = 0; index < rows.length;) {
    let count = Math.min(500, rows.length - index);
    while (count > 0) {
      const batch = rows.slice(index, index + count);
      const command = {
        leaseToken,
        chunkIndex: chunks.length,
        chunkHash: productCatalogContentHash(batch),
        rows: batch,
      };
      if (Buffer.byteLength(JSON.stringify(command), "utf8") <= 1_024 * 1_024) {
        chunks.push(productCatalogSyncStageRequestSchema.parse(command));
        index += count;
        break;
      }
      count = Math.floor(count / 2);
    }
    if (count === 0)
      throw new ProductCatalogSyncCommandError("VALIDATION_FAILED");
  }
  return chunks;
}

export async function productCatalogSyncCommand(
  baseUrl: string,
  token: string,
  command: ProductCatalogSyncRequest | null,
  options: Options = {},
) {
  if (!command)
    return request(
      baseUrl,
      token,
      productCatalogSyncPath,
      null,
      productCatalogSyncStatusSchema,
      options,
    );
  const state = readProductCatalogSheetConfig(options.env ?? process.env);
  if (!state.configured)
    throw new ProductCatalogSyncCommandError("VALIDATION_FAILED");
  const begin = await request(
    baseUrl,
    token,
    productCatalogSyncRunsPath,
    command,
    productCatalogSyncBeginResultSchema,
    options,
  );
  if (!begin.leaseToken) return begin.result;
  let publishing = false;
  try {
    const read =
      options.readSheet ??
      (await createGoogleProductCatalogReader(state.config, options));
    const first = normalizeProductCatalogRows(await read());
    const contentHash = productCatalogContentHash(first);
    const second = normalizeProductCatalogRows(await read());
    if (contentHash !== productCatalogContentHash(second))
      throw new ProductCatalogAcquisitionError("SOURCE_CHANGED");
    for (const chunk of productCatalogStageChunks(second, begin.leaseToken)) {
      await request(
        baseUrl,
        token,
        `${productCatalogRunPath(begin.runId)}/stage`,
        chunk,
        productCatalogSyncStageResultSchema,
        options,
      );
    }
    publishing = true;
    return await request(
      baseUrl,
      token,
      `${productCatalogRunPath(begin.runId)}/publish`,
      {
        leaseToken: begin.leaseToken,
        contentHash,
        expectedRowCount: second.length,
        parserVersion: productCatalogParserVersion,
      },
      productCatalogSyncResultSchema,
      options,
    );
  } catch (error) {
    if (!publishing) {
      const errorCode =
        error instanceof ProductCatalogAcquisitionError ||
        error instanceof ProductCatalogSourceValidationError ||
        error instanceof ProductCatalogSyncCommandError
          ? error.code
          : "PERSISTENCE_FAILED";
      await request(
        baseUrl,
        token,
        `${productCatalogRunPath(begin.runId)}/fail`,
        {
          leaseToken: begin.leaseToken,
          errorCode,
        },
        productCatalogSyncResultSchema,
        options,
      ).catch(() => undefined);
    }
    if (
      error instanceof ProductCatalogAcquisitionError ||
      error instanceof ProductCatalogSourceValidationError ||
      error instanceof ProductCatalogSyncCommandError
    )
      throw error;
    throw new ProductCatalogSyncCommandError();
  }
}

export function loginProductCatalogOperator(
  env: Record<string, string | undefined>,
  transport: typeof fetch = fetch,
) {
  return loginSheetSyncOperator(
    {
      ...env,
      CIRNE_SHEET_SYNC_EMAIL: env.CIRNE_PRODUCT_CATALOG_SYNC_EMAIL,
      CIRNE_SHEET_SYNC_PASSWORD: env.CIRNE_PRODUCT_CATALOG_SYNC_PASSWORD,
    },
    transport,
  );
}
